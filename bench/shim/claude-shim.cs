// A stand-in for claude.exe that the bench puts first on PATH. It runs the real
// claude with the exact command line it was given, copies stdout through
// unchanged, and keeps a copy of each call's output so the bench can read the
// CLI's own usage (input, output and cache tokens, cost, turns, model), which
// the ledger only keeps as one total. The runtime strips unknown variables from
// an agent's environment, so everything the shim needs sits beside it on disk.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

class ClaudeShim
{
    // The real claude runs in a job that dies with the shim, so a shim that is
    // killed (or whose caller goes away) never leaves claude running.
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int length);

    [DllImport("kernel32.dll")]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    const int ExtendedLimitInformation = 9;
    const uint KillOnJobClose = 0x2000;

    static string ArgsTail(string line)
    {
        int i = 0;
        if (line.Length > 0 && line[0] == '"')
        {
            i = line.IndexOf('"', 1);
            i = i < 0 ? line.Length : i + 1;
        }
        else
        {
            while (i < line.Length && line[i] != ' ' && line[i] != '\t') i++;
        }
        while (i < line.Length && (line[i] == ' ' || line[i] == '\t')) i++;
        return line.Substring(i);
    }

    static string Json(string s)
    {
        var b = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') b.Append('\\').Append(c);
            else if (c < ' ') b.AppendFormat("\\u{0:x4}", (int)c);
            else b.Append(c);
        }
        return b.Append('"').ToString();
    }

    static int Main()
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string real = File.ReadAllText(Path.Combine(dir, "real-claude.txt")).Trim();
        string calls = Path.Combine(dir, "calls");
        Directory.CreateDirectory(calls);
        string id = DateTime.UtcNow.ToString("yyyyMMdd'T'HHmmssfff") + "-" + Process.GetCurrentProcess().Id;
        string tail = ArgsTail(Environment.CommandLine);
        File.WriteAllText(Path.Combine(calls, id + ".start.json"),
            "{\"started\":" + Json(DateTime.UtcNow.ToString("o")) + ",\"cwd\":" + Json(Environment.CurrentDirectory) +
            ",\"args\":" + Json(tail) + "}\n");

        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        var limits = new ExtendedLimits();
        limits.Basic.LimitFlags = KillOnJobClose;
        SetInformationJobObject(job, ExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(ExtendedLimits)));

        var psi = new ProcessStartInfo(real, tail);
        psi.UseShellExecute = false;
        psi.RedirectStandardOutput = true;
        var p = Process.Start(psi);
        AssignProcessToJobObject(job, p.Handle);
        var src = p.StandardOutput.BaseStream;
        var dst = Console.OpenStandardOutput();
        // Shared, so the bench can read a call's output while it is still running.
        using (var copy = new FileStream(Path.Combine(calls, id + ".out"), FileMode.Create, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete))
        {
            var buf = new byte[65536];
            int n;
            while ((n = src.Read(buf, 0, buf.Length)) > 0)
            {
                copy.Write(buf, 0, n);
                copy.Flush();
                try
                {
                    dst.Write(buf, 0, n);
                    dst.Flush();
                }
                catch (IOException)
                {
                    // The caller went away: stop claude rather than run on unheard.
                    p.Kill();
                    break;
                }
            }
        }
        p.WaitForExit();
        File.WriteAllText(Path.Combine(calls, id + ".end.json"),
            "{\"ended\":" + Json(DateTime.UtcNow.ToString("o")) + ",\"exit\":" + p.ExitCode + "}\n");
        return p.ExitCode;
    }
}

// A file imported with Vite's `?raw` suffix is its text, inlined at build time.
declare module "*?raw" {
  const text: string;
  export default text;
}

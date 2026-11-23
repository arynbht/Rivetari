// The real open.mjs starts the map's server. Rivetari must never run it.
import { run } from "./fake.mjs";

run("open.mjs VIOLATION", () => ({ ok: true }));

// The real serve.mjs is the map's server, the only part that reaches the
// network (the Floorplan Cloud waitlist). Rivetari must never run it.
import { run } from "../scripts/fake.mjs";

run("serve.mjs VIOLATION", () => ({ ok: true }));

// Select this entry explicitly on PiG when automatic host detection is unavailable.
// Load it instead of src/index.ts, never alongside another implementation.
export { codemodeDiffPiG as default } from "./index.ts";

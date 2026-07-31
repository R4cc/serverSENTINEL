/**
 * The panel's console buffers. One hub for the process, so every viewer of a server — websocket or
 * polling fallback — reads the same numbered lines from the same buffer.
 */

import { runtimeForServer } from "../appServices.js";
import { ConsoleHub } from "./consoleHub.js";

export type { ConsoleCursor } from "./consoleHub.js";

export const consoleHub = new ConsoleHub((server, upstream) => runtimeForServer(server).streamConsole(server, upstream));

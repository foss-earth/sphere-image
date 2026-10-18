#!/usr/bin/env node
import { prepareSphereAsync } from "./projection-preparation.mjs";
try { process.exitCode = (await prepareSphereAsync(process.argv.slice(2))).exitCode; }
catch (error) { console.error(`prepare-panorama: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }

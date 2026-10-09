#!/usr/bin/env node
import { evidenceFixtures } from "./evidence/fixtures.js";
import { printEvidenceReport, runEvidenceEval } from "./evidence/runEvidenceEval.js";

const run = runEvidenceEval(evidenceFixtures);
printEvidenceReport(run);
if (run.metrics.passed !== run.metrics.total) process.exitCode = 1;

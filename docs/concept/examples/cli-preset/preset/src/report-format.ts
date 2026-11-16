import { escapeMarkdown } from '@bughunter/core';
import type { ReportFormat } from '@bughunter/core';

import type { CliStep } from './types.ts';

function commandText(step: CliStep): string {
  const argv = step.argv ?? [step.targetRef];
  const setup = step.setup === undefined || step.setup.length === 0
    ? ''
    : ` (подготовка: ${step.setup.map((entry) => entry.join(' ')).join('; ')})`;
  const exit = step.exitCode === undefined ? '' : step.exitCode === null ? ' → сигнал' : ` → exit ${step.exitCode}`;
  return `${argv.join(' ')}${setup}${exit}`;
}

export const cliReportFormat: ReportFormat = {
  finding(finding) {
    return [
      `### ${finding.kind}: ${finding.targetRef}`,
      '',
      `- Finding: ${finding.id}`,
      // В `widget` у находки обхода — сценарий: «<имя>: <argv…>».
      ...(finding.widget === undefined ? [] : [`- Сценарий: ${finding.widget}`]),
      `- Detail: ${finding.detail.replaceAll('\n', ' ')}`,
      `- Status: ${finding.status}`,
      ...(finding.candidateId === undefined ? [] : [`- Candidate: ${finding.candidateId}`]),
      `- Responses: ${finding.responseHashes.length}`,
    ];
  },
  candidate(candidate) {
    const steps = (candidate.minimalSteps ?? candidate.steps) as CliStep[];
    return steps.map((step, index) => `${index + 1}. ${escapeMarkdown(commandText(step))}`);
  },
};

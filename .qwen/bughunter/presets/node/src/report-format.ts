import { escapeMarkdown } from '@bughunter/core';
import type { ReportFormat } from '@bughunter/core';

import type { NodeStep } from './types.ts';

function requestText(step: NodeStep): string {
  const method = step.method ?? 'GET';
  const path = step.path ?? step.targetRef;
  const body = step.body === undefined ? '' : ` ${JSON.stringify(step.body)}`;
  const status = step.status === undefined ? '' : ` → ${step.status}`;
  return `${method} ${path}${body}${status}`;
}

export const nodeReportFormat: ReportFormat = {
  finding(finding) {
    return [
      `### ${finding.kind}: ${finding.targetRef}`,
      '',
      `- Finding: ${finding.id}`,
      // В `widget` у находки обхода — сценарий: «<имя> <МЕТОД> <путь>».
      ...(finding.widget === undefined ? [] : [`- Сценарий: ${finding.widget}`]),
      `- Detail: ${finding.detail.replaceAll('\n', ' ')}`,
      `- Status: ${finding.status}`,
      ...(finding.candidateId === undefined ? [] : [`- Candidate: ${finding.candidateId}`]),
      `- Responses: ${finding.responseHashes.length}`,
    ];
  },
  candidate(candidate) {
    const steps = (candidate.minimalSteps ?? candidate.steps) as NodeStep[];
    return steps.map((step, index) => `${index + 1}. ${escapeMarkdown(requestText(step))}`);
  },
};

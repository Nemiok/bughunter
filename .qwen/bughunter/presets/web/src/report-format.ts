import { escapeMarkdown } from '@bughunter/core';
import type { Finding, ReportFormat } from '@bughunter/core';
import type { Step } from './types.ts';

function stepText(step: Step): string {
  if (step.kind === 'act') {
    const target = step.locator ?? step.elementId ?? 'unknown element';
    return `${step.action ?? 'act'} ${target}${step.value === undefined ? '' : ` value=${step.value}`}`;
  }
  if (step.kind === 'navigate') return `navigate ${step.path ?? 'unknown path'}`;
  return `probe ${step.probe ?? 'unknown probe'}`;
}

export const webReportFormat: ReportFormat = {
  candidate(candidate) {
    const steps = (candidate.minimalSteps ?? candidate.steps) as Step[];
    return steps.map((step, index) => `${index + 1}. ${escapeMarkdown(stepText(step))}`);
  },
  finding(finding: Finding) {
    return [
      `### ${finding.kind}: ${finding.targetRef}`, '',
      `- Finding: ${finding.id}`,
      ...(finding.subject === undefined ? [] : [`- Widget: ${finding.subject}`]),
      `- Detail: ${finding.detail.replaceAll('\n', ' ')}`,
      `- Status: ${finding.status}`,
      ...(finding.candidateId === undefined ? [] : [`- Candidate: ${finding.candidateId}`]),
      `- Responses: ${finding.evidenceHashes.length}`,
    ];
  },
};

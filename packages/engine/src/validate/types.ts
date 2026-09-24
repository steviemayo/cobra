export type Severity = 'error' | 'warning';

export type IssueRef =
  | { kind: 'model' }
  | { kind: 'device'; id: string }
  | { kind: 'port'; id: string; parentId: string }
  | { kind: 'connection'; id: string }
  | { kind: 'group'; id: string }
  | { kind: 'state'; id: string }
  | { kind: 'activity'; id: string }
  | { kind: 'trigger'; id: string };

export interface ValidationIssue {
  severity: Severity;
  code: string;
  message: string;
  ref: IssueRef;
}

export interface ValidationResult {
  /** True when there are no errors (warnings allowed). */
  valid: boolean;
  issues: ValidationIssue[];
}

export interface ValidateOptions {
  /** When set, `control.kind === 'driver'` must reference one of these driver ids. */
  knownDrivers?: ReadonlySet<string>;
}

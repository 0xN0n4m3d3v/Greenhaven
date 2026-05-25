import type {LoadedProject, ValidationIssue} from '../core/types.js';
import {validateProject} from '../validators/validateProject.js';
import {exportGrinhavenSql, type GrinhavenSqlExportReport} from './exportGrinhavenSql.js';

export type ValidatedGrinhavenSqlExportReport =
  | (GrinhavenSqlExportReport & {
      forced: boolean;
      warnings: ValidationIssue[];
      validationErrors?: ValidationIssue[];
    })
  | {
      ok: false;
      errors: ValidationIssue[];
      warnings: ValidationIssue[];
    };

export async function exportValidatedGrinhavenSql(
  loaded: LoadedProject,
  outFile?: string,
  options: {force?: boolean} = {},
): Promise<ValidatedGrinhavenSqlExportReport> {
  const issues = await validateProject(loaded);
  const errors = issues.filter(issue => issue.level === 'error');
  const warnings = issues.filter(issue => issue.level === 'warning');
  const force = options.force === true;
  if (errors.length > 0 && !force) {
    return {ok: false, errors, warnings};
  }
  const report = await exportGrinhavenSql(loaded, outFile);
  return {
    ...report,
    forced: force,
    warnings,
    ...(errors.length > 0 ? {validationErrors: errors} : {}),
  };
}

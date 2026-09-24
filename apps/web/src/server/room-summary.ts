import 'server-only';
import { RoomModel } from '@kestrel/model';
import { validateRoomModel } from '@kestrel/engine';

export interface DraftSummary {
  revision: number;
  updatedAt: Date;
  devices: number;
  activities: number;
  errors: number;
  warnings: number;
}

// Summarise a stored draft for lists. A stored model that no longer parses counts as one error.
export function summariseDraft(draft: {
  revision: number;
  updatedAt: Date;
  model: unknown;
}): DraftSummary {
  const parsed = RoomModel.safeParse(draft.model);
  if (!parsed.success)
    return {
      revision: draft.revision,
      updatedAt: draft.updatedAt,
      devices: 0,
      activities: 0,
      errors: 1,
      warnings: 0,
    };
  const result = validateRoomModel(parsed.data);
  return {
    revision: draft.revision,
    updatedAt: draft.updatedAt,
    devices: parsed.data.devices.length,
    activities: parsed.data.activities.length,
    errors: result.issues.filter((i) => i.severity === 'error').length,
    warnings: result.issues.filter((i) => i.severity === 'warning').length,
  };
}

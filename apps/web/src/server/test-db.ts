// A tiny in-memory stand-in for the parts of Prisma the services use, so they can be tested
// without a database. Supports equality, not / in / contains / endsWith / lte conditions, orderBy, aggregate (_max) and createMany.
export type Row = Record<string, unknown>;

type Cond = {
  not?: unknown;
  in?: unknown[];
  notIn?: unknown[];
  startsWith?: string;
  endsWith?: string;
  contains?: string;
  mode?: 'insensitive';
  lte?: Date | number;
  lt?: Date | number;
  gte?: Date | number;
  gt?: Date | number;
};

export function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    // Logical operators: NOT (none may match), OR (any must match), AND (all must match).
    if (k === 'NOT')
      return ([] as Row[]).concat(cond as Row | Row[]).every((w) => !matches(row, w));
    if (k === 'OR') return (cond as Row[]).some((w) => matches(row, w));
    if (k === 'AND') return ([] as Row[]).concat(cond as Row | Row[]).every((w) => matches(row, w));
    const v = row[k];
    // Prisma always has a column; a row built without one means null.
    if (cond === null) return v === null || v === undefined;
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Cond;
      if ('not' in c) return v !== c.not;
      if ('in' in c) return c.in!.includes(v);
      if ('notIn' in c) return !c.notIn!.includes(v);
      if ('startsWith' in c) return typeof v === 'string' && v.startsWith(c.startsWith!);
      if ('endsWith' in c || 'contains' in c) {
        if (typeof v !== 'string') return false;
        const fold = (x: string) => (c.mode === 'insensitive' ? x.toLowerCase() : x);
        return (
          (!('endsWith' in c) || fold(v).endsWith(fold(c.endsWith!))) &&
          (!('contains' in c) || fold(v).includes(fold(c.contains!)))
        );
      }
      const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : NaN;
      const at = (x: Date | number) => new Date(x).getTime();
      if ('lte' in c || 'lt' in c || 'gte' in c || 'gt' in c)
        return (
          (!('lte' in c) || t <= at(c.lte!)) &&
          (!('lt' in c) || t < at(c.lt!)) &&
          (!('gte' in c) || t >= at(c.gte!)) &&
          (!('gt' in c) || t > at(c.gt!))
        );
    }
    return v === cond;
  });
}

const compare = (a: unknown, b: unknown) => {
  const x = a instanceof Date ? a.getTime() : (a as number | string);
  const y = b instanceof Date ? b.getTime() : (b as number | string);
  return x < y ? -1 : x > y ? 1 : 0;
};

export function table(rows: Row[], uniqueOn?: string[]) {
  return {
    rows,
    findFirst: async ({
      where,
      orderBy,
    }: { where?: Row; orderBy?: Record<string, 'asc' | 'desc'> } = {}) => {
      const hit = rows.filter((r) => matches(r, where));
      if (orderBy) {
        const [[key, dir]] = Object.entries(orderBy) as [[string, 'asc' | 'desc']];
        hit.sort((a, b) => compare(a[key], b[key]) * (dir === 'desc' ? -1 : 1));
      }
      return hit[0] ?? null;
    },
    findMany: async ({
      where,
      orderBy,
      take,
    }: { where?: Row; orderBy?: Record<string, 'asc' | 'desc'>; take?: number } = {}) => {
      const hit = rows.filter((r) => matches(r, where));
      if (orderBy) {
        const [[key, dir]] = Object.entries(orderBy) as [[string, 'asc' | 'desc']];
        hit.sort((a, b) => compare(a[key], b[key]) * (dir === 'desc' ? -1 : 1));
      }
      return take ? hit.slice(0, take) : hit;
    },
    count: async ({ where }: { where?: Row } = {}) => rows.filter((r) => matches(r, where)).length,
    aggregate: async ({ where, _max }: { where?: Row; _max: Record<string, true> }) => {
      const hit = rows.filter((r) => matches(r, where));
      const max: Record<string, unknown> = {};
      for (const key of Object.keys(_max))
        max[key] = hit.length
          ? hit.map((r) => r[key] as number).reduce((a, b) => (b > a ? b : a))
          : null;
      return { _max: max };
    },
    delete: async ({ where }: { where: Row }) => {
      const i = rows.findIndex((r) => matches(r, where));
      return rows.splice(i, 1)[0]!;
    },
    deleteMany: async ({ where }: { where?: Row } = {}) => {
      let count = 0;
      for (let i = rows.length - 1; i >= 0; i--)
        if (matches(rows[i]!, where)) {
          rows.splice(i, 1);
          count++;
        }
      return { count };
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = rows.find((r) => matches(r, where))!;
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: { where?: Row; data: Row }) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
    create: async ({ data }: { data: Row }) => {
      const row = { id: crypto.randomUUID(), ...data };
      rows.push(row);
      return row;
    },
    createMany: async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const d of data) {
        const dup = uniqueOn && rows.some((r) => uniqueOn.every((k) => compare(r[k], d[k]) === 0));
        if (dup && skipDuplicates) continue;
        rows.push(d);
        count++;
      }
      return { count };
    },
  };
}

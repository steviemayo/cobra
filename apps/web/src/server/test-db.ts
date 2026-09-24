// A tiny in-memory stand-in for the parts of Prisma the services use, so they can be tested
// without a database. Supports equality, not / in / lte conditions, orderBy and createMany.
export type Row = Record<string, unknown>;

type Cond = {
  not?: unknown;
  in?: unknown[];
  lte?: Date | number;
  lt?: Date | number;
  gte?: Date | number;
  gt?: Date | number;
};

export function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    // Prisma always has a column; a row built without one means null.
    if (cond === null) return v === null || v === undefined;
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Cond;
      if ('not' in c) return v !== c.not;
      if ('in' in c) return c.in!.includes(v);
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
    findFirst: async ({ where }: { where?: Row }) => rows.find((r) => matches(r, where)) ?? null,
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

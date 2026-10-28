import type { Sql } from '@ispace/db';

// postgres.js compatible tagged queries, including its nested SQL fragments.
export function pgliteSql(engine: any): Sql {
  const fragment = (parts: readonly string[], values: any[]): any => ({ parts, values, then(resolve: any, reject: any) {
    const params: any[]=[];
    function render(item: any): string {
      let text=item.parts[0];
      for(let i=0;i<item.values.length;i++) {
        const value=item.values[i];
        text += value?.parts ? render(value) : (params.push(value), '$'+params.length);
        text += item.parts[i+1];
      }
      return text;
    }
    return engine.query(render(this), params).then((r: any)=>r.rows).then(resolve,reject);
  }, catch(reject: any) { return this.then(undefined, reject); }});
  const sql=(parts: readonly string[],...values: any[])=>fragment(parts,values);
  sql.json=(v: unknown)=>JSON.stringify(v);
  sql.unsafe=(text: string)=>fragment([text],[]);
  if (typeof engine.transaction === 'function') sql.begin=(fn: (tx: Sql) => unknown)=>engine.transaction((tx: any)=>fn(pgliteSql(tx)));
  Object.assign(sql, { end: async () => {} });
  return sql as unknown as Sql;
}

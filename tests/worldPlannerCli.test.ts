import { afterAll, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
const root=mkdtempSync(join(tmpdir(),'world-planner-cli-'));
afterAll(()=>{
  const parent=resolve(tmpdir())+sep,target=resolve(root);
  if(!target.startsWith(parent)||!target.includes('world-planner-cli-')) throw new Error('unsafe temp cleanup');
  rmSync(target,{recursive:true,force:true});
});
it.each([['world-plan','oasis'],['Town','town']])('preserves every town task when IDs are %s and %s', (first,second)=>{
  const plan=JSON.parse(readFileSync(new URL('../scripts/fixtures/world-plan.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
  plan.towns[0].id=first;plan.towns[1].id=second;
  const input=join(root,first+'.input.json'),out=join(root,first+'-tasks');
  writeFileSync(input,JSON.stringify(plan));
  const result=spawnSync(process.execPath,['--import','tsx','scripts/worldPlanner.ts','tasks',input,out],{encoding:'utf8'});
  expect(result.status,result.stderr).toBe(0);
  const files=readdirSync(out);
  expect(new Set(files.map(f=>f.toLowerCase())).size).toBe(3);
  const contents=files.map(f=>JSON.parse(readFileSync(join(out,f),'utf8')));
  expect(contents.filter(c=>c.town).map(c=>c.town.id).sort()).toEqual([first,second].sort());
  expect(contents.filter(c=>c.version===1&&c.towns)).toHaveLength(1);
});


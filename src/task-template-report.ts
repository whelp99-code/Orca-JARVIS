/** Versioned sandbox program: argv values contain paths; never interpolate them into source. */
export const TASK_REPORT_PROGRAM_V1 = [
  "const fs=require('node:fs');",
  "const [output,id,fieldsArg,sourcesArg]=process.argv.slice(1);",
  "const fields=JSON.parse(fieldsArg),sources=JSON.parse(sourcesArg);",
  "const text=v=>typeof v==='string'&&v.trim().length>0&&Buffer.byteLength(v)<=8192;",
  "const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===k.sort().join(',');",
  "const read=p=>{const b=fs.readFileSync(p);const s=b.toString('utf8');if(!Buffer.from(s).equals(b))throw Error('utf8');return s;};",
  "try{const r=JSON.parse(read(output));",
  "if(!exact(r,['schema_version','template_id','references',...fields])||r.schema_version!==1||r.template_id!==id)throw Error('shape');",
  "for(const f of fields)if(!Array.isArray(r[f])||r[f].length<1||r[f].length>32||!r[f].every(text))throw Error('section');",
  "if(!Array.isArray(r.references)||r.references.length<1||r.references.length>32)throw Error('references');",
  "const cache=new Map();for(const ref of r.references){",
  "if(!exact(ref,['path','quote'])||!sources.includes(ref.path)||!text(ref.quote))throw Error('reference');",
  "if(!cache.has(ref.path))cache.set(ref.path,read(ref.path));",
  "if(!cache.get(ref.path).includes(ref.quote))throw Error('quote');}",
  "}catch{process.exitCode=1;}",
].join(' ');

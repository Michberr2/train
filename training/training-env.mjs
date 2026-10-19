import fs from 'node:fs'
import path from 'node:path'
import {parseEnv} from 'node:util'
// Explicit nonempty process values win, then training-specific values, then
// repository defaults. Blank placeholders must not hide configured credentials.
export function loadTrainingEnv(trainingDir,env=process.env,read=file=>fs.readFileSync(file,'utf8')){
 for(const file of [path.join(trainingDir,'.env.local'),path.join(path.dirname(trainingDir),'.env.local')]){
  let values
  try{values=parseEnv(read(file))}catch(error){if(error.code==='ENOENT')continue;throw error}
  for(const [key,value] of Object.entries(values))if((env[key]===undefined||env[key]==='')&&value!=='')env[key]=value
 }
}

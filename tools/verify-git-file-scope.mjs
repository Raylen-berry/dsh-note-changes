import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {syncAfterWrite} from '../index.js'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dnc-git-scope-'))
const git=(args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']})
try {
 git(['init']);git(['config','user.name','Workspace Test']);git(['config','user.email','test@example.invalid'])
 for(const f of ['current.md','unrelated.md'])fs.writeFileSync(path.join(dir,f),'original\n')
 git(['add','current.md','unrelated.md']);git(['commit','-m','fixture'])
 fs.writeFileSync(path.join(dir,'unrelated.md'),'already staged\n');git(['add','unrelated.md'])
 fs.writeFileSync(path.join(dir,'current.md'),'edited in workspace\n')
 const note=await syncAfterWrite({rel:'current.md',message:'current note only',runGit:async args=>{
   if(args[0]==='push')return {code:0,stdout:''}
   try{return {code:0,stdout:git(args.map(a=>a.replace(/^"|"$/g,'')))}}catch(e){return {code:1,stderr:String(e.stderr)}}
 }})
 assert.match(note,/已提交并推送/)
 assert.equal(git(['show','--pretty=format:','--name-only','HEAD']).trim(),'current.md')
 assert.equal(git(['diff','--cached','--name-only']).trim(),'unrelated.md')
 console.log('2 项真实 Git 文件范围检查通过：只提交当前笔记，其他暂存内容保留')
} finally { fs.rmSync(dir,{recursive:true,force:true}) }

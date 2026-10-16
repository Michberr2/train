import assert from 'node:assert/strict'

export async function cloudflareNotebookCases({api,store,worker,env}) {
  const oldEnv={...process.env},oldFetch=globalThis.fetch
  Object.assign(process.env,{NALU_STORAGE_BACKEND:'cloudflare',CLOUDFLARE_DATA_URL:'https://fixture.invalid',CLOUDFLARE_DATA_SECRET:env.NALU_DATA_SECRET})
  globalThis.fetch=(url,init)=>{assert.ok(String(url).startsWith('https://fixture.invalid/'));return worker.fetch(new Request(url,init),env)}
  const owner='notebook-owner'
  await store.batch([
    {sql:'INSERT INTO nalu_users(id,display_name,salt,hash) VALUES(?,?,?,?)',params:[owner,'Notebook','salt','hash']},
    {sql:'INSERT INTO nalu_sessions(token,user_id) VALUES(?,?)',params:[owner,owner]},
  ])
  const invoke=async(body,token=owner)=>{
    const res={code:200,status(n){this.code=n;return this},json(v){this.body=v;return this},setHeader(){}}
    await api.dataHandler({method:'POST',body,headers:{authorization:`Bearer ${token}`}},res)
    return res
  }
  try {
    const action={text:'Review the release',owner:'Michael',due:null,done:false}
    const note={id:'meeting_one',title:'Release meeting',createdAt:new Date().toISOString(),summary:'Cloudflare cutover',analyzedCount:1,segments:[{id:'segment_one',at:new Date().toISOString(),text:'Move the database and review the notarized desktop release.'}],actions:[action]}
    const save=(id,changes)=>invoke({action:'notes-save',mutation:{id,noteId:note.id,changes}})
    let first=await save('create-note',[{kind:'create',note}]);assert.equal(first.code,200,JSON.stringify(first.body))
    assert.equal((await save('create-note',[{kind:'create',note}])).body.note.updatedAt,first.body.note.updatedAt)
    assert.equal((await save('create-note',[{kind:'title',title:'Different'}])).code,409)
    const changes=await Promise.all([save('title-edit',[{kind:'title',title:'Remember the release'}]),save('append-new',[{kind:'append',segments:[{id:'segment_two',at:new Date().toISOString(),text:'The unicorn logo must stay whimsical.'}]}])])
    assert.ok(changes.every(r=>r.code===200),JSON.stringify(changes))
    let notes=(await invoke({action:'notes-list'})).body.notes
    assert.equal(notes[0].title,'Remember the release');assert.equal(notes[0].segments.length,2)
    const tracked=await invoke({action:'notes-track',noteId:note.id,key:api.actionKey(action)})
    assert.equal(tracked.code,200,JSON.stringify(tracked.body));const taskId=tracked.body.note.actions[0].taskId;assert.ok(taskId)
    assert.equal((await save('check-action',[{kind:'check',key:api.actionKey(action),done:true}])).code,200)
    assert.equal((await invoke({action:'task-feed'})).body.tasks.find(t=>t.id===taskId).status,'done')
    const group={id:'release_group',name:'Release team',emails:['owner@example.invalid']}
    const groups=await Promise.all([invoke({action:'notes-group',requestId:'group-create',group}),invoke({action:'notes-group',requestId:'group-create',group})])
    assert.ok(groups.every(r=>r.code===200));assert.equal(groups[0].body.groups.length,1)
    assert.equal((await invoke({action:'notes-group',requestId:'group-create',group:{...group,name:'Different'}})).code,409)
    const longSegments=Array.from({length:85},(_,i)=>({id:'long_'+i,at:new Date().toISOString(),text:'A wolf 🐺 and a unicorn 🦄. '.repeat(1000)}))
    assert.equal((await save('append-large',[{kind:'append',segments:longSegments.slice(0,42)}])).code,200)
    const large=await save('append-large-two',[{kind:'append',segments:longSegments.slice(42)}]);assert.equal(large.code,200,JSON.stringify(large.body))
    notes=(await invoke({action:'notes-list'})).body.notes;assert.equal(notes[0].segments.length,87)
    assert.ok(Buffer.byteLength(JSON.stringify(notes[0]))>2000000)
    assert.equal((await store.query('SELECT length(document) AS n FROM nalu_notes WHERE user_id=?',[owner])).results[0].n<20000,true)
    assert.equal((await invoke({action:'notes-send',confirmed:true,requestId:'email-test',noteId:note.id,updatedAt:first.body.note.updatedAt,recipients:group.emails})).code,409)
    let sent=0
    const sender=async()=>{sent++;return {ok:true,detail:'Provider fixture accepted'}}
    const emailed=await Promise.all([api.sendNotebook(store,owner,note,'email-once',group.emails,sender),api.sendNotebook(store,owner,note,'email-once',group.emails,sender)])
    assert.equal(sent,1);assert.ok(emailed.some(r=>r.status==='accepted'))
    assert.equal((await api.notebookDeliveries(store,owner,note.id))[0].status,'accepted')
    await assert.rejects(api.sendNotebook(store,owner,{...note,title:'Changed'},'email-once',group.emails,sender),/different content/)
    console.log('PASS Cloudflare notebook mutation receipts, concurrent edits, multi-megabyte Unicode transcripts, atomic task checklists, recipient groups and exactly one email intent with a simulated provider')
  }finally {
    globalThis.fetch=oldFetch
    for(const key of Object.keys(process.env))if(!(key in oldEnv))delete process.env[key]
    Object.assign(process.env,oldEnv)
  }
}

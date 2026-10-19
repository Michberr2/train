import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'

const bundle = await build({ stdin: { contents: `
  import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
  import WorkspaceSwarm from './client/src/components/workspace-preview/real/WorkspaceSwarm';
  export const render = swarm => renderToStaticMarkup(React.createElement(WorkspaceSwarm, {swarm, navigationKey:0, availableChatIds:[], onOpenChat(){}}));
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', loader: { '.css': 'empty' }, write: false,
  banner: { js: `import {createRequire} from 'node:module'; const require=createRequire(${JSON.stringify(`${process.cwd()}/package.json`)});` } })
const { render } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
function controller(content, mode = 'live', speaker = 'Rocky') {
  const project = { id: 'launch', title: 'Launch', brief: 'A launch', members: ['Nalu', 'Rocky', 'Milo'], createdAt: 1, updatedAt: 1 }
  const message = { id: 'reply-one', projectId: project.id, thread: 'group', speaker, content, createdAt: 2 }
  return { state: { version: 1, mode, projects: [project], tasks: [], messages: [message], turns: [] }, activeProjectId: project.id, recipient: 'group', messages: [message], tasks: [], draft: '', pending: false, pendingCount: 0, creating: false, error: '', recentRooms: [], setDraft(){}, setCreating(){}, selectProject(){}, selectRecipient(){}, navigate(){}, send(){}, stop(){}, createProject(){}, addTask(){}, updateTask(){}, assignTask(){} }
}

test('real Swarm replies render safe readable Markdown, links and unchanged code', () => {
  const content = '## Research\n\n[Source](https://example.com/evidence)\n\n```python\nif True:\n    cost = "$180"\n```\n\n<img src=x onerror="alert(1)">\n\n[Unsafe](javascript:alert(1))'
  const html = render(controller(content))
  assert.match(html, /<h2[^>]*>Research<\/h2>/)
  assert.match(html, /href="https:\/\/example.com\/evidence"/)
  assert.match(html, /target="_blank" rel="noreferrer"/)
  assert.match(html, /if True:\n    cost = &quot;\$180&quot;/)
  assert.ok(!html.includes('<img src="x"')); assert.ok(!html.includes('href="javascript:'))
  assert.ok(html.includes('&lt;img src=x onerror='), 'raw HTML stays text')
  assert.ok(!html.includes('Local sample'))
})

test('user messages stay plain text and fixture labels remain explicit', () => {
  const user = render(controller('## My literal request', 'live', 'You'))
  assert.ok(user.includes('<p>## My literal request</p>'))
  assert.ok(render(controller('A sample reply', 'sample')).includes('Local sample'))
})

test('the globe belongs to agent replies, never workspace loading or message submission', () => {
  const ready = controller('A saved reply')
  const loading = { ...ready, loading: true, state: { ...ready.state, projects: [], messages: [] }, messages: [] }
  const loadingHtml = render(loading)
  assert.match(loadingHtml, /Loading your Swarm workspaces/)
  assert.doesNotMatch(loadingHtml, /class="nalu-globe/)
  const sendingHtml = render({ ...ready, sending: true })
  assert.match(sendingHtml, /Sending your message/)
  assert.doesNotMatch(sendingHtml, /class="nalu-globe/)
  assert.doesNotMatch(render(ready), /class="nalu-globe/)
  for (const speaker of ['Nalu', 'Rocky', 'Milo']) {
    const turn = { id: `turn-${speaker}`, projectId: 'launch', thread: 'group', status: 'pending', replySpeaker: speaker, userMessageId: 'request', replyId: `reply-${speaker}`, createdAt: 3, updatedAt: 3 }
    const replying = render({ ...ready, pending: true, pendingCount: 1, state: { ...ready.state, turns: [turn] } })
    assert.match(replying, /class="nalu-globe/)
    assert.ok(replying.includes(`${speaker} is replying`), speaker)
  }
})

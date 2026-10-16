import { ownsPhone } from './_phoneOwner'
import { TEAM_VOICES } from './_team'
import type { PhoneVoice } from './_telephony'
import { ensureSchema } from './_db'
import { connectionBackend } from './_connectionBackend'
import { CloudflareStore } from './_cloudflareStore'
import { CloudflareQuestionPhone } from './_cloudflareQuestionPhone'
import { CloudflareQuestions } from './_cloudflareQuestions'
import { answerTaskQuestion, ensureQuestionSchema } from './_taskQuestions'
import { publicBase, verifySig, sendCallXml, sayPolly, xmlEscape } from './_telephony'

// Called only after phone.ts has verified the Telnyx signature. The HMAC binds
// this question to its account, destination, and expiry. The call SID is bound
// on first delivery so a later call cannot reuse the same question URL.
export async function handleTaskQuestionPhone(req: any, res: any, form: Record<string, string>) {
  const q = req.query || {}
  const uid = String(q.uid || ''), questionId = String(q.questionId || ''), to = String(q.to || '')
  const expires = String(q.expires || ''), nonce = String(q.nonce || ''), signature = String(q.sig || '')
  const sid = String(form.CallSid || '')
  let voice: PhoneVoice = 'britishWoman'
  const finish = (text: string) => sendCallXml(res, sayPolly(text, voice) + '<Hangup/>')
  if (!ownsPhone(uid) || !questionId || !sid || to !== String(form.To || '') || !Number.isFinite(Number(expires)) || Number(expires) < Date.now() ||
    !verifySig(['task-question', uid, questionId, to, expires, nonce].join('|'), signature)) {
    finish('This task call could not be verified. Please check Nalu Voice.'); return
  }
  const attempt = Math.max(0, Number(q.attempt) || 0)
  const listen = (text: string, phase = 'answer') => {
    if (attempt >= 3) { finish('I could not confirm your answer. Your task is still waiting in Nalu Voice.'); return }
    const params = new URLSearchParams({ step: 'task-question', uid, questionId, to, expires, nonce, sig: signature, sid, phase, attempt: String(attempt + 1) })
    const action = xmlEscape(`${publicBase()}/api/phone?${params}`)
    // Read the entire question/confirmation, even when neural TTS is enabled;
    // the general TTS helper caps its text and could omit part of an answer.
    sendCallXml(res, `<Gather input="speech" action="${action}" method="POST" speechTimeout="1" language="en-US">${sayPolly(text, voice)}</Gather><Redirect method="POST">${action}</Redirect>`)
  }
  const backend=connectionBackend(),client=backend.client
  try {
    await backend.connect(); if(!(client instanceof CloudflareStore)){await ensureSchema(client as any); await ensureQuestionSchema(client)}
    const binding=client instanceof CloudflareStore?await new CloudflareQuestionPhone(client).bind(uid,questionId,sid):null
    const question:any = client instanceof CloudflareStore?binding!.question:(await client.query(`SELECT q.*,j.status AS job_status,j.lease_expires_at,t.meta AS task_meta FROM nalu_task_questions q
      JOIN nalu_task_jobs j ON j.id=q.task_id JOIN nalu_tasks t ON t.id=q.task_id WHERE q.id=$1 AND q.user_id=$2`, [questionId, uid])).rows[0]
    if (!question || question.status !== 'pending' || question.job_status !== 'running' || new Date(question.lease_expires_at).getTime() <= Date.now()) {
      finish('This task is no longer waiting for an answer. Please check Nalu for its latest status.'); return
    }
    if (TEAM_VOICES.includes(question.task_meta?.memberVoice)) voice = question.task_meta.memberVoice as PhoneVoice
    const bound = client instanceof CloudflareStore?binding!.bound:(await client.query('UPDATE nalu_task_questions SET call_sid=$2 WHERE id=$1 AND (call_sid IS NULL OR call_sid=$2) RETURNING id', [questionId, sid])).rows.length>0
    if (!bound) { finish('This question belongs to another call. Please check Nalu Voice.'); return }
    const said = String(form.SpeechResult || '').trim()
    if (/^(?:goodbye|bye|hang up|not now|call later)[.!]?$/i.test(said)) { finish('Your task will keep waiting. You can answer in Nalu Voice when you are ready.'); return }
    if (q.phase === 'confirm' && question.phone_draft && /^(?:yes|yes please|correct|that is correct|that's correct|confirm|go ahead)[.!]?$/i.test(said)) {
      const result = client instanceof CloudflareStore?await new CloudflareQuestions(client).answer(uid,question.task_id,questionId,question.phone_draft,{sid,draft:question.phone_draft}):await answerTaskQuestion(client, uid, question.task_id, questionId, question.phone_draft)
      finish(result.data.ok ? 'Answer saved. Nalu is continuing the same task on your computer.' : 'I could not save the answer. Please check the task in Nalu Voice.'); return
    }
    if (q.phase === 'confirm' && /^(?:no|incorrect|wrong|try again)[.!]?$/i.test(said)) { listen('Please tell me the answer again.'); return }
    if (!said) { listen(q.phase === 'confirm' && question.phone_draft ? `I heard: ${question.phone_draft}. Say yes to continue with that answer, or no to correct it.` : `${question.task_meta?.memberName || 'Nalu'} needs one answer to continue: ${question.text}`, q.phase === 'confirm' ? 'confirm' : 'answer'); return }
    if (said.length > 2000) { listen('Please give me a shorter answer, or answer in Nalu Voice.'); return }
    if(client instanceof CloudflareStore){if(!await new CloudflareQuestionPhone(client).draft(uid,questionId,sid,said)){finish('This task is no longer waiting for an answer. Please check Nalu.');return}}
    else await client.query('UPDATE nalu_task_questions SET phone_draft=$3 WHERE id=$1 AND call_sid=$2 AND status=\'pending\'', [questionId, sid, said])
    listen(`I heard: ${said}. Say yes to continue with that answer, or no to correct it.`, 'confirm')
  } finally { await backend.close().catch(() => {}) }
}

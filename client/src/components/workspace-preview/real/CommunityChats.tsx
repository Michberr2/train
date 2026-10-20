import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { ArrowUp, Copy, Plus, Users } from 'lucide-react'
import { getToken } from '../../../lib/localAuth'
import HumanAvatar, { getHumanAvatar, isHumanAvatarId, HUMAN_AVATARS } from '../../workspace/HumanAvatar'
import '../../workspace/human-avatar.css'
import './community-chats.css'

type Room = { id: string; title: string; ownerId: string; createdAt: number; memberCount: number }
type Message = { id: string; content: string; createdAt: number; userId: string; name: string; avatar: string }
async function call(body: Record<string, unknown>) {
  const token = getToken()
  if (!token) throw new Error('Sign in to use shared chats.')
  const response = await fetch('/api/community', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  const value = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : 'Shared chats are unavailable.')
  return value
}

export default function CommunityChats() {
  const [rooms, setRooms] = useState<Room[]>([]), [active, setActive] = useState(''), [messages, setMessages] = useState<Message[]>([])
  const [title, setTitle] = useState(''), [draft, setDraft] = useState(''), [invite, setInvite] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const reload = useCallback(async () => { try { const value = await call({ action: 'list' }); setRooms(Array.isArray(value.rooms) ? value.rooms : []); setError('') } catch (reason) { setError(reason instanceof Error ? reason.message : 'Shared chats are unavailable.') } }, [])
  const loadMessages = useCallback(async (roomId: string) => { try { const value = await call({ action: 'messages', roomId }); setMessages(Array.isArray(value.messages) ? value.messages : []) } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not load this shared chat.') } }, [])
  useEffect(() => { void reload(); const query = new URLSearchParams(location.search), token = query.get('communityInvite'); if (token) setInvite(token); }, [reload])
  useEffect(() => { if (!active) return; void loadMessages(active); const timer = setInterval(() => void loadMessages(active), 4000); return () => clearInterval(timer) }, [active, loadMessages])
  const create = async (event: FormEvent) => { event.preventDefault(); if (!title.trim() || busy) return; setBusy(true); setError(''); try { const value = await call({ action: 'create', title: title.trim() }); setRooms(old => [value.room, ...old]); setActive(value.room.id); setTitle('') } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not create a shared chat.') } finally { setBusy(false) } }
  const join = async (event: FormEvent) => { event.preventDefault(); const match = invite.match(/communityInvite=([^&]+)/); const token = decodeURIComponent(match?.[1] || invite.trim()); if (!token || busy) return; setBusy(true); setError(''); try { const value = await call({ action: 'join', token }); await reload(); setActive(value.room.id); setInvite(''); history.replaceState(null, '', location.pathname + location.hash) } catch (reason) { setError(reason instanceof Error ? reason.message : 'That invite could not be used.') } finally { setBusy(false) } }
  const share = async () => { if (!active) return; try { const value = await call({ action: 'invite', roomId: active }); const url = new URL(location.href); url.searchParams.set('communityInvite', value.token); await navigator.clipboard.writeText(url.toString()); setError('Invite link copied. It expires in 7 days.') } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not create an invite.') } }
  const send = async (event: FormEvent) => { event.preventDefault(); if (!draft.trim() || !active || busy) return; setBusy(true); const content = draft.trim(); setDraft(''); try { const value = await call({ action: 'send', roomId: active, content }); setMessages(value.messages || []) } catch (reason) { setDraft(content); setError(reason instanceof Error ? reason.message : 'Message was not sent.') } finally { setBusy(false) } }
  return <details className="community-chats"><summary><Users size={15}/><strong>Shared chats</strong><span>{rooms.length ? `${rooms.length} room${rooms.length === 1 ? '' : 's'}` : 'Invite people into a room'}</span></summary>
    <div className="community-chat-content"><aside><form onSubmit={event => void create(event)}><input aria-label="New shared chat name" placeholder="New room name" maxLength={80} value={title} onChange={event => setTitle(event.target.value)}/><button type="submit" disabled={!title.trim() || busy} aria-label="Create shared room"><Plus size={15}/></button></form><form onSubmit={event => void join(event)}><input aria-label="Invite link" placeholder="Paste invite link" value={invite} onChange={event => setInvite(event.target.value)}/><button type="submit" disabled={!invite.trim() || busy}>Join</button></form><nav aria-label="Shared chat rooms">{rooms.map(room => <button type="button" key={room.id} aria-pressed={active === room.id} onClick={() => setActive(room.id)}><strong>{room.title}</strong><span>{room.memberCount} people</span></button>)}</nav></aside>
      <section className="community-chat-room">{active ? <><header><div><h3>{rooms.find(room => room.id === active)?.title || 'Shared chat'}</h3><span>People in this room can read its messages.</span></div><button type="button" onClick={() => void share()} aria-label="Copy invite link"><Copy size={15}/>Invite</button></header><div className="community-chat-messages" role="log" aria-label="Shared chat messages">{messages.map(message => <article key={message.id}><HumanAvatar value={isHumanAvatarId(message.avatar) ? message.avatar : HUMAN_AVATARS[0]} name={message.name} size={30}/><div><header><strong>{message.name}</strong><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></header><p>{message.content}</p></div></article>)}</div><form className="community-chat-compose" onSubmit={event => void send(event)}><HumanAvatar value={getHumanAvatar()} size={30}/><input aria-label="Message shared chat" placeholder="Message everyone…" maxLength={4000} value={draft} onChange={event => setDraft(event.target.value)}/><button type="submit" disabled={!draft.trim() || busy} aria-label="Send message"><ArrowUp size={16}/></button></form></> : <div className="community-chat-empty"><Users size={21}/><p>Create a shared room or join one with an invite link.</p></div>}</section>
    </div>{error && <p className="community-chat-status" role="status">{error}</p>}
  </details>
}

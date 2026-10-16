import { distanceScale, dogScale, strideRate } from './naluFriends'
import type { DogContacts } from './naluFriends'

export type PackName = 'nalu' | 'milo' | 'rocky'
type Phase = 'arriving' | 'chase' | 'coil' | 'leap' | 'pickup' | 'carry' | 'drop' | 'nudge' | 'handoff' | 'social'
type Point = { x: number; y: number; z: number }
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n))
const mix = (a: number, b: number, t: number) => a + (b - a) * t
const ease = (t: number) => t * t * (3 - 2 * t)
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
export type PackDog = {
  name: PackName; x: number; z: number; yaw: number; facing: number; speed: number; travelSpeed: number; zSpeed: number; gait: number
  dip: number; hop: number; leap: number; mouthOpen: boolean; mode: string; arrival: number
  pickups: number; drops: number; nudges: number; pounceHits: number; carryError: number
}
const dog = (name: PackName, x: number): PackDog => ({ name, x, z: 0, yaw: 0, facing: 1, speed: 0, travelSpeed: 0, zSpeed: 0, gait: 0, dip: 0, hop: 0, leap: 0, mouthOpen: false, mode: 'watch', arrival: name === 'nalu' ? 1 : 0, pickups: 0, drops: 0, nudges: 0, pounceHits: 0, carryError: 0 })

/** One ball, one owner, three animated animals. Possession is granted only by
 * contact with a rendered nose. Every dog gets a turn; the others stay in pursuit. */
export class FriendsPlay {
  dogs: Record<PackName, PackDog>
  ball: Point
  owner: PackName | null = null
  active: PackName = 'milo'
  phase: Phase = 'arriving'
  elapsed = 0
  time = 0
  socialGames = 0
  greetings = 0
  private greeted = false
  private vx = 0
  private vy = 0
  private vz = 0
  private carryTarget = 0
  private grab: Point
  private released = false
  private pounced = false
  private touched = false
  private jumpStart = 0
  private jumpEnd = 0
  private trail: { at: number; x: number; z: number }[] = []
  constructor(x: number, bx: number, private reduced = false) {
    this.dogs = { nalu: dog('nalu', x), milo: dog('milo', -3), rocky: dog('rocky', 3) }
    this.ball = { x: bx, y: .23, z: 0 }; this.grab = { ...this.ball }
  }
  private stage(phase: Phase) { this.phase = phase; this.time = 0 }
  private steer(d: PackDog, targetX: number, targetZ: number, maxSpeed: number, dt: number, keepFacing = false) {
    const dx = targetX - d.x
    const dz = targetZ - d.z
    if (!keepFacing && Math.abs(dx) > .2 && (Math.abs(d.speed) < .7 || Math.sign(dx) === Math.sign(d.speed))) d.facing = Math.sign(dx)
    const wanted = (d.facing > 0 ? 0 : Math.PI) + clamp(-dz * .18, -.45, .45)
    let turn = wanted - d.yaw; turn = Math.atan2(Math.sin(turn), Math.cos(turn))
    d.yaw += clamp(turn, -dt * 6, dt * 6)
    const turnBrake = Math.abs(turn) > .7 ? Math.max(.2, Math.cos(Math.min(Math.abs(turn), Math.PI / 2))) : 1
    const target = clamp(dx * 3.2, -maxSpeed, maxSpeed) * turnBrake
    d.speed += (target - d.speed) * Math.min(1, dt * 5.5)
    d.zSpeed += (clamp(dz * 2.8, -3.2, 3.2) - d.zSpeed) * Math.min(1, dt * 5.5)
    d.x += d.speed * dt; d.z += d.zSpeed * dt
    d.travelSpeed = Math.hypot(d.speed, d.zSpeed)
    const localSpeed = d.travelSpeed / (distanceScale(d.z) * dogScale(d.name))
    d.gait += localSpeed * dt * strideRate(d.name, localSpeed)
  }
  step(dt: number, width: number) {
    if (this.reduced) {
      const positions = { milo: -4.7, nalu: 0, rocky: 4.2 }
      for (const d of Object.values(this.dogs)) { d.x = positions[d.name]; d.z = 0; d.arrival = 1; d.mode = 'rest'; d.yaw = d.name === 'rocky' ? Math.PI : 0 }
      this.ball.x = 2.55
      return
    }
    this.elapsed += dt; this.time += dt
    const bound = Math.max(4.8, width / 2 - 2.5)
    const attached = this.owner !== null
    if (!attached) {
      this.ball.x += this.vx * dt; this.ball.z += this.vz * dt
      this.vx *= Math.exp(-1.1 * dt); this.vz *= Math.exp(-2 * dt)
      this.vy -= 8 * dt; this.ball.y += this.vy * dt
      if (this.ball.y < .23) { this.ball.y = .23; this.vy = Math.abs(this.vy) > .5 ? Math.abs(this.vy) * .45 : 0 }
      if (Math.abs(this.ball.x) > bound + 1) { this.ball.x = Math.sign(this.ball.x) * (bound + 1); this.vx *= -.6 }
    }
    const actor = this.dogs[this.active]
    for (const d of Object.values(this.dogs)) { d.hop = 0; d.leap = 0; d.mouthOpen = false; d.mode = 'follow' }
    if (this.phase === 'social') {
      if (this.time < 3 || this.time > 10) {
        const positions = { nalu: -2.7, milo: 2.15, rocky: 4.6 }
        for (const d of Object.values(this.dogs)) {
          d.facing = d.name === 'nalu' ? 1 : -1
          this.steer(d, positions[d.name], d.name === 'rocky' ? -2.2 : -.4, 5.5, dt, true)
          d.mode = this.time < 1.5 ? 'greet' : 'bow'
          if (d.mode === 'bow') d.gait += dt * 1.8
          d.dip += ((d.name === 'milo' ? .72 : .48) - d.dip) * Math.min(1, dt * 6)
        }
      } else {
        const radius = Math.min(5.1, width / 2 - 2.3)
        const angle = (this.time - 3) * 1.05
        const leader = this.dogs.milo
        this.steer(leader, Math.sin(angle) * radius, -1.3 + Math.cos(angle) * 2.2, 6.4, dt)
        this.trail.push({ at: this.time, x: leader.x, z: leader.z })
        this.trail = this.trail.filter(p => p.at > this.time - 3)
        for (const [i, name] of (['milo', 'nalu', 'rocky'] as const).entries()) {
          const d = this.dogs[name]
          if (i) {
            const past = this.trail.find(p => p.at >= this.time - i * .75) || this.trail[0]
            this.steer(d, past.x, past.z - i * .5, name === 'rocky' ? 6.1 : 6.5, dt)
          }
          d.mode = 'tag'; d.dip += (.1 - d.dip) * Math.min(1, dt * 6)
          d.hop = Math.max(0, Math.sin(d.gait)) * (name === 'rocky' ? .035 : .055)
        }
      }
      if (this.time > 12.5) { this.active = 'rocky'; this.pounced = false; this.stage('chase') }
      return
    }
    if (this.phase === 'arriving') {
      this.steer(this.dogs.nalu, 0, 0, 5, dt)
      for (const [name, delay] of [['milo', 0], ['rocky', .65]] as const) {
        const d = this.dogs[name], u = clamp((this.elapsed - delay) / 3.6, 0, 1)
        d.arrival = u; d.z = -18 * (1 - u) ** 1.2
        const startX = Math.min(width / 2 - 1.5, name === 'milo' ? 11 : 10) * (name === 'milo' ? -1 : 1)
        d.x = mix(startX, name === 'milo' ? -5.4 : 4.9, ease(u))
        d.facing = name === 'milo' ? 1 : -1; d.yaw = d.facing > 0 ? -.28 : Math.PI + .28
        d.speed = u > 0 && u < 1 ? 4.5 : 0; d.travelSpeed = d.speed
        d.gait += dt * (name === 'milo' ? 12 : 16) * (u > 0 && u < 1 ? 1 : 0)
        d.mode = u < 1 ? 'arriving' : 'watch'
      }
      if (this.elapsed > 4.35) this.stage('chase')
      return
    }
    // Onlookers follow from different depth lanes so solid bodies do not collide.
    const waiting = Object.values(this.dogs).filter(d => d.name !== this.active)
    waiting.forEach((d, i) => {
      const target = clamp(this.ball.x + (i ? 4.4 : -4.7), -bound, bound)
      this.steer(d, target, i ? -1.8 : -3.1, 5.3, dt)
      if (Math.abs(d.speed) < .4) d.facing = Math.sign(this.ball.x - d.x) || 1
      d.dip += (.13 - d.dip) * Math.min(1, dt * 6)
    })
    const reach = (this.active === 'nalu' ? 2.43 : this.active === 'milo' ? 1.65 : 1.66) * distanceScale(actor.z) * dogScale(this.active)
    if (this.phase === 'chase' || this.phase === 'nudge') {
      const delta = this.ball.x - actor.x
      if (Math.abs(delta) > reach + .45) actor.facing = Math.sign(delta)
      // Keep facing the ball while adjusting the last few inches in reverse.
      const face = actor.facing, target = this.ball.x - face * reach
      this.steer(actor, target, this.ball.z, this.active === 'rocky' ? 6.3 : 7, dt, Math.abs(delta) < reach + .6)
      if (Math.abs(delta) < reach + .6) actor.facing = face
      actor.mode = this.phase
      actor.dip += ((Math.abs(delta) < reach + 1.3 ? 1 : .2) - actor.dip) * Math.min(1, dt * 7)
      if (this.active === 'nalu' && this.phase === 'chase' && !this.pounced && Math.abs(delta) > 3.6 && Math.abs(delta) < 6 && this.ball.y < .4) {
        this.pounced = true; this.stage('coil')
      }
    } else if (this.phase === 'coil') {
      this.steer(actor, actor.x, 0, 0, dt); actor.mode = 'coil'
      if (this.time > .25) { this.jumpStart = actor.x; this.jumpEnd = this.ball.x - actor.facing * 1.25; this.touched = false; this.stage('leap') }
    } else if (this.phase === 'leap') {
      const t = clamp(this.time / .56, 0, 1)
      actor.x = mix(this.jumpStart, this.jumpEnd, t); actor.speed = (this.jumpEnd - this.jumpStart) / .56
      actor.z *= Math.exp(-dt * 12); actor.hop = Math.sin(Math.PI * t) * .8; actor.leap = t; actor.mode = 'pounce'
      if (t >= 1) this.stage('chase')
    } else if (this.phase === 'pickup') {
      this.steer(actor, actor.x, actor.z, 0, dt); actor.mode = 'pickup'; actor.mouthOpen = true
      if (this.time > .3) {
        this.carryTarget = clamp(actor.x + (actor.x > 0 ? -1 : 1) * 4.5, -bound + 1, bound - 1)
        this.stage('carry')
      }
    } else if (this.phase === 'carry') {
      this.steer(actor, this.carryTarget, 0, 1.7, dt); actor.mode = 'carry'; actor.mouthOpen = true
      actor.dip += (.18 - actor.dip) * Math.min(1, dt * 5)
      if (this.time > 2.7) { this.released = false; this.stage('drop') }
    } else if (this.phase === 'drop') {
      this.steer(actor, actor.x, 0, 0, dt); actor.mode = 'drop'; actor.mouthOpen = true
      actor.dip += (1 - actor.dip) * Math.min(1, dt * 7)
      if (this.time > .6 && !this.released) { this.owner = null; this.released = true; actor.drops++; this.vx = actor.facing * .3; this.vy = 0; this.vz = 0 }
      if (this.time > 1.05) this.stage('nudge')
    } else if (this.phase === 'handoff') {
      actor.mode = 'watch'; this.steer(actor, actor.x, -.6, 0, dt)
      if (this.time > .45) {
        if (this.active === 'milo') { this.socialGames++; this.greeted = false; this.trail = []; this.stage('social'); return }
        this.active = this.active === 'rocky' ? 'nalu' : 'milo'
        this.pounced = false; this.stage('chase')
      }
    }
  }
  afterPose(contacts: Record<PackName, DogContacts>) {
    if (this.reduced || this.phase === 'arriving') return
    if (this.phase === 'social') {
      if (!this.greeted && distance(contacts.nalu.nose, contacts.milo.nose) < .8) { this.greeted = true; this.greetings++ }
      return
    }
    const d = this.dogs[this.active], rendered = contacts[this.active]
    if (this.phase === 'leap' && !this.touched && rendered.paws.some(p => distance(p, this.ball) < .55)) {
      this.touched = true; d.pounceHits++; this.vx = d.facing * 1.8; this.vy = 1
    }
    if ((this.phase === 'chase' || this.phase === 'nudge') && this.owner === null && distance(rendered.nose, this.ball) < .5) {
      if (this.phase === 'nudge') {
        d.nudges++; this.vx = d.facing * 4.5; this.vy = 1.5; this.vz = -this.ball.z * 2
        this.stage('handoff')
      } else {
        this.owner = this.active; d.pickups++; this.grab = { ...this.ball }; this.vx = 0; this.vy = 0; this.vz = 0; this.stage('pickup')
      }
    }
    if (this.owner) {
      const mouth = contacts[this.owner].mouth
      const t = this.phase === 'pickup' ? ease(clamp(this.time / .3, 0, 1)) : 1
      this.ball.x = mix(this.grab.x, mouth.x, t); this.ball.y = mix(this.grab.y, mouth.y, t); this.ball.z = mix(this.grab.z, mouth.z, t)
      this.dogs[this.owner].carryError = this.phase === 'carry' ? distance(mouth, this.ball) : 0
    }
  }
}

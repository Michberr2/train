import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { naluMouthContour } from './naluMouthContour'
import { createFriend, distanceScale, dogScale } from './naluFriends'
import { FriendsPlay } from './naluFriendsRuntime'

const random = (min: number, max: number) => min + Math.random() * (max - min)

/** One continuous little playground shared by all five landing pages. */
export default function NaluChase() {
  const host = useRef<HTMLDivElement>(null)
  const toggleFriends = useRef<(enabled: boolean) => void>(() => {})
  const [friendsActive, setFriendsActive] = useState(false)
  useEffect(() => {
    const el = host.current!
    let renderer: THREE.WebGLRenderer
    try { renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true }) } catch { return }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0, 0)
    el.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-10, 10, 4, -0.5, 0.1, 100)
    camera.position.set(0, 2.2, 18)
    camera.lookAt(0, 0, 0)
    scene.add(new THREE.HemisphereLight(0xe6f0ff, 0x5d536b, 2.5))
    const key = new THREE.DirectionalLight(0xfff3de, 3.8)
    key.position.set(-3, 8, 7)
    scene.add(key)
    const rim = new THREE.DirectionalLight(0xaccfff, 2.8)
    rim.position.set(3, 4, -4)
    scene.add(rim)
    const fur = new THREE.MeshBasicMaterial({ color: 0x272729 })
    const furEdge = new THREE.MeshBasicMaterial({ color: 0x222224 })
    const white = new THREE.MeshStandardMaterial({ color: 0xf2f0e9, roughness: 0.4 })
    const sphere = new THREE.SphereGeometry(1, 24, 16)
    function part(parent: THREE.Object3D, material: THREE.Material, pos: number[], scale: number[], geometry: THREE.BufferGeometry = sphere) {
      const mesh = new THREE.Mesh(geometry, material)
      mesh.position.set(pos[0], pos[1], pos[2])
      mesh.scale.set(scale[0], scale[1], scale[2])
      parent.add(mesh)
      return mesh
    }
    const wolf = new THREE.Group()
    scene.add(wolf)
    const torso = new THREE.Group()
    torso.position.y = -0.22
    wolf.add(torso)
    function silhouette(parent: THREE.Object3D, shape: THREE.Shape, depth: number) {
      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth, steps: 1, bevelEnabled: true, bevelThickness: 0.012,
        bevelSize: 0.008, bevelSegments: 2, curveSegments: 16,
      })
      geometry.translate(0, 0, -depth / 2)
      const mesh = new THREE.Mesh(geometry, [fur, furEdge])
      parent.add(mesh)
      return mesh
    }
    function outline(points: number[][]) {
      const shape = new THREE.Shape()
      points.forEach(([x, y], i) => i ? shape.lineTo(x, y) : shape.moveTo(x, y))
      shape.closePath()
      return shape
    }
    const anatomy = new THREE.Group()
    torso.add(anatomy)
    // Side-profile proportions studied from the Montana State University wolf photo:
    // https://www.montana.edu/extension/images/wwu2.jpg
    // Long lower limbs, deep ribs above the elbows, broad ruff, and a low brush.
    const body = new THREE.Shape()
    body.moveTo(-1.78, 2.05)
    body.bezierCurveTo(-1.72, 2.37, -1.5, 2.48, -1.18, 2.45)
    body.bezierCurveTo(-0.76, 2.4, -0.35, 2.46, -0.1, 2.55)
    // Small, swept guard hairs break the contour without changing the back's anatomy.
    body.lineTo(-0.14, 2.6)
    body.lineTo(0.02, 2.59)
    body.lineTo(-0.01, 2.65)
    body.lineTo(0.19, 2.63)
    body.bezierCurveTo(0.45, 2.67, 0.74, 2.79, 0.97, 2.77)
    // Continue underneath the logo's flat lower edge to form one sloping throat.
    body.bezierCurveTo(1.34, 2.69, 1.65, 2.37, 1.65, 2.02)
    body.bezierCurveTo(1.48, 1.87, 1.32, 1.78, 1.18, 1.64)
    body.lineTo(1.2, 1.69)
    body.lineTo(1.07, 1.57)
    body.lineTo(1.09, 1.62)
    body.bezierCurveTo(0.87, 1.39, 0.75, 1.25, 0.46, 1.2)
    body.bezierCurveTo(0.05, 1.15, -0.38, 1.37, -0.72, 1.48)
    body.bezierCurveTo(-0.94, 1.55, -1.18, 1.42, -1.36, 1.4)
    body.bezierCurveTo(-1.67, 1.39, -1.87, 1.68, -1.78, 2.05)
    const bodyMesh = silhouette(anatomy, body, 0.42)
    const bodyPositions = bodyMesh.geometry.getAttribute('position') as THREE.BufferAttribute
    const bodyRest = new Float32Array(bodyPositions.array)
    let lastBodyDip = -1
    const head = new THREE.Group()
    head.position.set(1.25, 2.35, 0)
    torso.add(head)
    // Contour traced from the alpha channel of /nalu-logo.png, left-hand mark.
    // Preserve the actual ears, muzzle and three ruff points; no added facial features.
    const logoContour = [[88,33],[85,34],[81,38],[72,52],[62,72],[59,75],[57,75],[55,71],[57,46],[58,45],[58,32],[56,32],[38,57],[29,74],[7,97],[7,99],[17,99],[18,100],[18,103],[1,121],[2,122],[11,122],[14,124],[12,128],[1,138],[0,140],[1,142],[97,142],[97,140],[95,137],[97,133],[104,130],[106,128],[123,119],[128,115],[131,114],[135,110],[135,107],[133,104],[112,91],[96,83],[88,76],[86,70],[86,54],[87,53]]
    const closedHead = silhouette(head, outline(logoContour.map(([x, y]) => [(x - 64) / 80, (110 - y) / 80])), 0.36)
    const openHead = silhouette(head, outline(naluMouthContour), 0.36)
    openHead.visible = false
    const tail = new THREE.Group()
    tail.position.set(-1.6, 2.15, 0)
    anatomy.add(tail)
    const brush = new THREE.Shape()
    brush.moveTo(0.14, 0.15)
    brush.bezierCurveTo(-0.28, 0.2, -0.53, -0.19, -0.63, -0.55)
    brush.lineTo(-0.7, -0.53)
    brush.lineTo(-0.69, -0.66)
    brush.bezierCurveTo(-0.78, -0.95, -0.91, -1.12, -1.02, -1.26)
    brush.lineTo(-0.93, -1.24)
    brush.lineTo(-0.99, -1.34)
    brush.quadraticCurveTo(-0.69, -1.37, -0.44, -1.08)
    brush.lineTo(-0.44, -1.15)
    brush.bezierCurveTo(-0.17, -0.94, -0.03, -0.65, 0.02, -0.41)
    brush.lineTo(0.055, -0.46)
    brush.bezierCurveTo(0.15, -0.22, 0.21, 0.02, 0.14, 0.15)
    silhouette(tail, brush, 0.3)
    const legs: { hip: THREE.Group; upper: THREE.Group; lower: THREE.Group; ankle: THREE.Group; paw: THREE.Group; hind: boolean; far: boolean; upperLength: number; lowerLength: number }[] = []
    for (const x of [-1.3, 0.58]) for (const z of [-0.27, 0.27]) {
      const hip = new THREE.Group()
      hip.position.set(x, 1.74, z)
      wolf.add(hip)
      const hind = x < 0, far = z < 0
      const upperLength = hind ? 0.88 : 0.83
      const lowerLength = hind ? 0.62 : 0.81
      const upper = new THREE.Group(), lower = new THREE.Group(), ankle = new THREE.Group(), paw = new THREE.Group()
      hip.add(upper, lower, ankle, paw)
      const thigh = new THREE.Shape()
      thigh.moveTo(-0.22, 0.17)
      thigh.bezierCurveTo(hind ? 0.38 : 0.27, 0.22, hind ? 0.32 : 0.2, -0.46, 0.12, -upperLength)
      thigh.lineTo(-0.12, -upperLength)
      thigh.quadraticCurveTo(-0.17, -0.64, -0.2, -0.52)
      thigh.lineTo(-0.25, -0.57)
      thigh.lineTo(-0.24, -0.4)
      thigh.lineTo(hind ? -0.34 : -0.29, -0.46)
      thigh.bezierCurveTo(hind ? -0.34 : -0.27, -0.22, -0.28, 0.02, -0.22, 0.17)
      silhouette(upper, thigh, 0.18)
      const calf = new THREE.Shape()
      calf.moveTo(-0.14, 0.06)
      calf.quadraticCurveTo(0.18, 0.1, 0.145, -0.3)
      calf.quadraticCurveTo(0.11, -lowerLength * 0.7, 0.11, -lowerLength)
      calf.lineTo(-0.1, -lowerLength)
      calf.lineTo(-0.12, -lowerLength + 0.16)
      calf.lineTo(-0.16, -lowerLength + 0.12)
      calf.lineTo(-0.145, -lowerLength * 0.5)
      calf.lineTo(-0.19, -lowerLength * 0.55)
      calf.quadraticCurveTo(-0.15, -0.15, -0.14, 0.06)
      silhouette(lower, calf, 0.18)
      if (hind) silhouette(ankle, outline([[-0.1,0.04],[0.1,0.04],[0.09,-0.267],[-0.09,-0.267],[-0.125,-0.19],[-0.105,-0.2]]), 0.16)
      const foot = new THREE.Shape()
      foot.moveTo(-0.11, 0.08)
      foot.bezierCurveTo(0.09, 0.13, 0.26, 0.05, 0.27, -0.035)
      foot.quadraticCurveTo(0.24, -0.09, -0.1, -0.065)
      foot.quadraticCurveTo(-0.15, -0.03, -0.11, 0.08)
      silhouette(paw, foot, 0.2)
      legs.push({ hip, upper, lower, ankle, paw, hind, far, upperLength, lowerLength })
    }
    const ball = new THREE.Group()
    scene.add(ball)
    const blue = new THREE.MeshStandardMaterial({ color: 0x6b9fff, roughness: 0.24, metalness: 0.08 })
    part(ball, blue, [0, 0, 0], [0.23, 0.23, 0.23])
    const stripeGeometry = new THREE.TorusGeometry(0.225, 0.015, 8, 40)
    ball.add(new THREE.Mesh(stripeGeometry, white))
    const shadowMaterial = new THREE.MeshBasicMaterial({ color: 0x17202f, transparent: true, opacity: 0.12, depthWrite: false })
    const wolfShadow = part(scene, shadowMaterial, [0, 0.04, 0], [1.35, 0.01, 0.45])
    const ballShadow = part(scene, shadowMaterial, [0, 0.035, 0], [0.3, 0.01, 0.22])
    let width = 20
    let x = -4.5, bx = 0, by = 0.23, vx = 0.3, vy = 0
    let facing = 1, speed = 0, gait = 0, elapsed = 0, cooldown = 0
    let mood = 'chase', moodTime = 1.5, hop = 0, nudges = 0
    let dip = 0, crouch = 0
    let runout = random(7.5, 10), returning = 0
    let excursion = false, exits = 0, returns = 0
    let ballState: 'free' | 'pickup' | 'carry' | 'drop' = 'free'
    let actionTime = 0, carryTarget = 0, released = false, mustNudge = false
    let pickups = 0, drops = 0, postDropNudges = 0
    let pickupX = 0, pickupY = 0, bz = 0
    let hunt: 'none' | 'stalk' | 'coil' | 'pounce' | 'land' = 'stalk'
    let huntTime = random(0.65, 1.05), huntCooldown = 0
    let flightStart = x, flightEnd = x, flightDuration = 0.7, flightHeight = 0.7, flightProgress = 0
    let stalks = 1, pounces = 0, pounceHits = 0, pounceTouched = false
    let zoomie: 'none' | 'out' | 'back' = 'none'
    let zoomieTime = 0, zoomieTarget = 0, nextZoomie = 5
    let zoomies = 0, feints = 0, bursts = 0, sprinting = false
    const pawContact = new THREE.Vector3()
    const mouth = new THREE.Vector3()
    let previous = 0, frame = 0
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    const milo = createFriend('milo', scene), rocky = createFriend('rocky', scene)
    for (const friend of [milo, rocky]) { friend.group.visible = false; friend.shadow.visible = false }
    let pack: FriendsPlay | null = null
    function resize() {
      const w = el.clientWidth, h = el.clientHeight
      width = Math.max(w / h * 4.5, pack ? 18 : 0)
      camera.left = -width / 2; camera.right = width / 2
      camera.top = width * h / w - .5
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
      draw(0)
    }
    function draw(dt: number) {
      elapsed += dt; cooldown -= dt; moodTime -= dt
      actionTime -= dt; huntTime -= dt; huntCooldown -= dt
      zoomieTime -= dt; nextZoomie -= dt
      let delta = bx - x, outside = Math.abs(x) > width / 2 + 3.6
      if (pack) {
        pack.step(dt, width)
        const dog = pack.dogs.nalu
        x = dog.x; speed = dog.travelSpeed / distanceScale(dog.z) * (Math.sign(dog.speed) || dog.facing); facing = dog.facing; hop = dog.hop; flightProgress = dog.leap
        bx = pack.ball.x; by = pack.ball.y; bz = pack.ball.z
        delta = bx - x; outside = Math.abs(x) > width / 2 + 3.6
        ballState = dog.mode === 'pickup' ? 'pickup' : dog.mode === 'carry' ? 'carry' : dog.mode === 'drop' ? 'drop' : 'free'
        hunt = dog.mode === 'pounce' ? 'pounce' : dog.mode === 'coil' ? 'coil' : 'none'
        mood = dog.mode === 'bow' ? 'bow' : 'chase'; zoomie = 'none'
      } else {
      if (ballState === 'pickup' && actionTime <= 0) {
        ballState = 'carry'
        actionTime = random(3, 5)
        // Carry at a walk, usually in view; an offscreen pickup heads back toward the page.
        carryTarget = Math.abs(x) > width / 2 ? 0 : x + facing * random(4, 7)
      } else if (ballState === 'carry' && actionTime <= 0) {
        ballState = 'drop'; actionTime = 0.95; released = false
      } else if (ballState === 'drop' && actionTime <= 0) {
        ballState = 'free'; mustNudge = true; cooldown = 0
        mood = 'chase'; moodTime = 1.5
      }
      // The playground continues beyond the camera; neither animal nor ball wraps.
      const bound = width / 2 + runout
      outside = Math.abs(x) > width / 2 + 3.6
      if (outside && !excursion) { exits++; excursion = true }
      if (excursion && Math.abs(x) < Math.max(1, width / 2 - 3.6)) {
        returns++
        excursion = false
      }
      if (returning && Math.abs(x) < Math.max(1, width / 2 - 3.6)) {
        returning = 0
        runout = random(7.5, 10)
      }
      if (ballState === 'free' && hunt === 'none' && zoomie === 'none' && moodTime <= 0) {
        const pick = Math.random()
        mood = pick < 0.06 ? 'sniff' : pick < 0.24 ? 'bow' : 'chase'
        moodTime = mood === 'chase' ? random(1.5, 3) : random(0.18, 0.4)
        if (Math.abs(x) > width / 2) mood = 'chase'
      }
      const attached = ballState === 'pickup' || ballState === 'carry' || (ballState === 'drop' && !released)
      if (!attached) {
        bz *= Math.exp(-dt * 12)
        bx += vx * dt
        vx *= Math.exp(-0.45 * dt)
        vy -= 8 * dt; by += vy * dt
        if (by < 0.23) { by = 0.23; vy = Math.abs(vy) > 0.4 ? Math.abs(vy) * 0.55 : 0 }
        // A ball that rolls far out of view waits for her to retrieve it.
        if (Math.abs(bx) > bound) { bx = Math.sign(bx) * bound; vx = 0 }
      }
      delta = bx - x
      if (ballState === 'free') {
        // Retreat in a short feint, then charge the ball. Finish the mouth-play
        // sequence first, and retrieve offscreen balls before starting another lap.
        if (zoomie === 'none' && hunt === 'none' && nextZoomie <= 0 && postDropNudges > 0
          && !mustNudge && !returning && !outside && Math.abs(bx) < width / 2) {
          zoomie = 'out'; zoomieTime = random(0.8, 1.05)
          zoomieTarget = x - (Math.sign(delta) || facing) * random(5, 7)
          zoomies++; feints++; mood = 'chase'
        } else if (zoomie === 'out' && (zoomieTime <= 0 || Math.abs(zoomieTarget - x) < 0.65 || outside)) {
          zoomie = 'back'; zoomieTime = 4
        } else if (zoomie === 'back' && (zoomieTime <= 0 || Math.abs(delta) < 3.5)) {
          zoomie = 'none'; nextZoomie = random(5, 8)
          huntCooldown = Math.min(huntCooldown, 0.3)
        }
        if (zoomie === 'none' && hunt === 'none' && huntCooldown <= 0 && !mustNudge && Math.abs(vx) < 1.1 && by < 0.3
          && Math.abs(delta) > 3.2 && Math.abs(delta) < 7 && Math.abs(x) < width / 2) {
          hunt = 'stalk'; huntTime = random(0.55, 1.1); stalks++
        } else if (hunt === 'stalk' && (Math.abs(delta) > 7 || Math.abs(x) > width / 2)) {
          hunt = 'none'; huntCooldown = random(4, 7)
        } else if (hunt === 'stalk' && huntTime <= 0 && Math.abs(delta) < 3.9) {
          hunt = 'coil'; huntTime = random(0.22, 0.34)
        } else if (hunt === 'coil' && huntTime <= 0) {
          hunt = 'pounce'; pounces++; pounceTouched = false
          flightDuration = random(0.5, 0.62); flightHeight = random(0.72, 0.95)
          huntTime = flightDuration; flightStart = x
          const predictedBall = bx + vx / 0.45 * (1 - Math.exp(-0.45 * flightDuration))
          flightEnd = predictedBall - facing * 1.25
        } else if (hunt === 'land' && huntTime <= 0) {
          hunt = 'none'; huntCooldown = random(4, 7)
          mood = 'chase'; moodTime = 1.5
        }
      }
      let target = 0
      if (ballState === 'carry') {
        const destination = carryTarget - x
        if (Math.abs(destination) > 0.25) facing = Math.sign(destination)
        target = THREE.MathUtils.clamp(destination * 2, -1.65, 1.65)
      } else if (ballState === 'free') {
        const destination = zoomie === 'out' ? zoomieTarget - x : delta
        if (Math.abs(destination) > 0.25) facing = Math.sign(destination)
        target = zoomie === 'out' ? THREE.MathUtils.clamp(destination * 4, -7.8, 7.8)
          : hunt === 'stalk' ? facing * THREE.MathUtils.clamp((Math.abs(delta) - 3.6) * 2.6, 0, 0.95)
          : hunt === 'coil' || hunt === 'land' ? 0
          : zoomie === 'none' && (mood === 'sniff' || mood === 'bow') ? 0
          : facing * THREE.MathUtils.clamp((Math.abs(delta) - 2.43) * 4.5, -1.2, zoomie === 'back' ? 7.8 : 6.8)
      }
      if (hunt === 'pounce') {
        flightProgress = THREE.MathUtils.clamp(1 - huntTime / flightDuration, 0, 1)
        x = THREE.MathUtils.lerp(flightStart, flightEnd, flightProgress)
        speed = (flightEnd - flightStart) / flightDuration
        hop = 4 * flightHeight * flightProgress * (1 - flightProgress)
        if (flightProgress >= 1) { hunt = 'land'; huntTime = 0.35; speed = 0; hop = 0 }
      } else {
        speed += (target - speed) * Math.min(1, dt * (ballState === 'carry' || hunt !== 'none' ? 7 : 10))
        x += speed * dt
        hop = 0
      }
      }
      const moving = Math.min(1, Math.abs(speed) / 1.4)
      const gallop = hunt === 'none' && ballState === 'free' ? THREE.MathUtils.smoothstep(Math.abs(speed), 3.4, 5.5) : 0
      const isSprinting = gallop > 0.8
      if (isSprinting && !sprinting) bursts++
      sprinting = isSprinting
      const gaitRate = hunt === 'stalk' ? 7 : THREE.MathUtils.lerp(4.2, 1.8, gallop)
      if (hunt !== 'pounce') gait += Math.abs(speed) * dt * gaitRate
      // Reach forward through the neck; keep the logo steady during an ordinary trot.
      const reaching = ballState === 'carry' ? false : ballState === 'pickup' || ballState === 'drop' || (Math.abs(delta) < 4.2 && hop < 0.08)
      const dipTarget = pack ? pack.dogs.nalu.dip : hunt === 'stalk' ? 0.38 : hunt === 'coil' ? 0.46 : hunt === 'pounce' ? 0.3
        : reaching || (ballState === 'free' && mood === 'sniff') ? 1 : 0
      dip += (dipTarget - dip) * Math.min(1, dt * 5)
      const crouchTarget = hunt === 'stalk' ? 0.22 : hunt === 'coil' ? 0.38 : hunt === 'land' ? 0.2 * huntTime / 0.35
        : hunt === 'pounce' ? 0 : mood === 'bow' && ballState === 'free' ? 0.13 : 0
      crouch += (crouchTarget - crouch) * Math.min(1, dt * 10)
      head.position.set(1.25 + dip * 0.45, 2.35 - dip * 1.24, 0)
      const mouthOpen = ballState !== 'free'
      openHead.visible = mouthOpen
      closedHead.visible = !mouthOpen
      head.rotation.z = -dip * 0.65
      // Bend the ruff into the reaching pose instead of stretching a separate neck block.
      if (Math.abs(dip - lastBodyDip) > 0.001) {
        for (let i = 0; i < bodyPositions.count; i++) {
          const px = bodyRest[i * 3], py = bodyRest[i * 3 + 1]
          const blend = THREE.MathUtils.smoothstep(px, -0.15, 1.45)
            * THREE.MathUtils.smoothstep(py, 1.15, 2.04)
          // Skin the throat to the same pivot as the head so its attachment cannot drift.
          const angle = head.rotation.z
          const localX = px - 1.25, localY = py - 2.35
          const attachedX = head.position.x + localX * Math.cos(angle) - localY * Math.sin(angle)
          const attachedY = head.position.y + localX * Math.sin(angle) + localY * Math.cos(angle)
          bodyPositions.setXYZ(i, px + (attachedX - px) * blend, py + (attachedY - py) * blend, bodyRest[i * 3 + 2])
        }
        bodyPositions.needsUpdate = true
        bodyMesh.geometry.computeVertexNormals()
        bodyMesh.geometry.computeBoundingSphere()
        lastBodyDip = dip
      }
      const bob = Math.cos(gait * 2) * 0.022 * moving * (1 - gallop) + Math.sin(gait) * 0.09 * gallop
      const wolfDepth = pack ? pack.dogs.nalu.z : 0
      wolf.scale.setScalar(distanceScale(wolfDepth))
      wolf.position.set(x, hop + (bob - crouch) * wolf.scale.y, wolfDepth)
      // Brake before turning so a fast reversal cannot slide tail-first.
      const travelFacing = hunt === 'none' && Math.abs(speed) > 0.6 ? Math.sign(speed) : facing
      const angle = pack ? pack.dogs.nalu.yaw : travelFacing > 0 ? 0 : Math.PI
      let turn = angle - wolf.rotation.y
      turn = Math.atan2(Math.sin(turn), Math.cos(turn))
      wolf.rotation.y += turn * Math.min(1, dt * 12)
      torso.rotation.z = -dip * 0.06 - crouch * 0.28 + Math.cos(gait) * 0.045 * gallop
      // Tail follows the pelvis, with restrained lateral movement rather than a constant wag.
      tail.rotation.x = Math.sin(gait * 0.5) * 0.12 * moving + Math.sin(elapsed * 2) * 0.035
      tail.rotation.z = hop * 0.16 + Math.sin(gait) * 0.04 * moving - gallop * 0.22
      legs.forEach(({ hip, upper, lower, ankle, paw, hind, far, upperLength, lowerLength }, i) => {
        // Diagonal pairs alternate. During stance the foot moves back beneath the body;
        // during swing it lifts and returns forward. IK keeps paws level at contact.
        const trotPhase = i === 0 || i === 3 ? 0 : 0.5
        const gallopPhase = hind ? (far ? 0 : 0.12) : (far ? 0.48 : 0.6)
        const phase = (gait / (Math.PI * 2) + THREE.MathUtils.lerp(trotPhase, gallopPhase, gallop)) % 1
        const stanceRatio = THREE.MathUtils.lerp(0.6, 0.42, gallop)
        // Match stance travel to distance covered, including the longer gallop
        // cycle, so more speed produces a bound instead of frantic foot sliding.
        const stride = Math.PI * stanceRatio / gaitRate * moving
        const stance = phase < stanceRatio
        const u = stance ? phase / stanceRatio : (phase - stanceRatio) / (1 - stanceRatio)
        const restX = hind ? -0.16 : 0.015
        const offset = far ? (hind ? 0.23 : -0.23) * (1 - moving) : 0
        let pawX = restX + offset + (stance ? stride * (1 - 2 * u) : -stride * Math.cos(Math.PI * u))
        const lift = stance ? 0 : Math.sin(Math.PI * u) * THREE.MathUtils.lerp(0.25, 0.44, gallop) * moving
        let pawY = -1.61 + lift + crouch - bob + (hop > 0 ? 0.12 : 0)
        if (hunt === 'pounce' || hunt === 'land') {
          const reach = hunt === 'land' ? 1 : THREE.MathUtils.smoothstep(flightProgress, 0.3, 0.9)
          pawX = hind ? -0.3 : THREE.MathUtils.lerp(-0.12, 0.67, reach)
          pawY = THREE.MathUtils.lerp(-1.05, -1.45, reach) + crouch
        }
        let endX = pawX - (hind ? 0.06 : 0)
        let endY = pawY + (hind ? 0.26 : 0)
        const distance = Math.min(upperLength + lowerLength - 0.003, Math.hypot(endX, endY))
        const reachScale = distance / Math.hypot(endX, endY)
        endX *= reachScale; endY *= reachScale
        pawX = endX + (hind ? 0.06 : 0); pawY = endY - (hind ? 0.26 : 0)
        const along = (upperLength ** 2 - lowerLength ** 2 + distance ** 2) / (2 * distance)
        const bend = (hind ? 1 : -1) * Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2))
        const kneeX = endX / distance * along - endY / distance * bend
        const kneeY = endY / distance * along + endX / distance * bend
        upper.rotation.z = Math.atan2(kneeX, -kneeY)
        lower.position.set(kneeX, kneeY, 0)
        lower.rotation.z = Math.atan2(endX - kneeX, -(endY - kneeY))
        ankle.position.set(endX, endY, 0)
        ankle.rotation.z = Math.atan2(pawX - endX, -(pawY - endY))
        paw.position.set(pawX, pawY, 0)

      })
      scene.updateMatrixWorld(true)
      if (!pack && (hunt === 'pounce' || hunt === 'land') && !pounceTouched) {
        for (const leg of legs.filter(leg => !leg.hind)) {
          leg.paw.getWorldPosition(pawContact)
          if (Math.hypot(pawContact.x - bx, pawContact.y - by) < 0.48) {
            pounceTouched = true; pounceHits++
            vx = facing * random(1.8, 2.5); vy = random(0.7, 1.2)
            break
          }
        }
      }
      const nose = new THREE.Vector3(0.89, 0.02, 0)
      head.localToWorld(nose)
      if (!pack && ballState === 'free' && hunt === 'none' && zoomie !== 'out' && cooldown <= 0 && Math.hypot(nose.x - bx, nose.y - by) < 0.48 && Math.abs(turn) < 0.35) {
        if (!mustNudge && (pickups === 0 || Math.random() < 0.32)) {
          zoomie = 'none'; nextZoomie = random(5, 8)
          ballState = 'pickup'; actionTime = 0.35
          pickupX = bx; pickupY = by; pickups++
          mood = 'chase'; moodTime = 2
          vx = 0; vy = 0
        } else {
          // Once she has followed it completely out of view, nose it back toward the page.
          if (outside) returning = -Math.sign(x)
          const kickDirection = returning || facing
          const longRun = returning !== 0 || Math.random() < 0.55
          vx = kickDirection * (longRun ? random(9, 12) : random(4, 7))
          vy = longRun ? random(0.8, 1.8) : random(1.2, 3.4)
          cooldown = random(0.7, 1.1); nudges++
          if (mustNudge) { postDropNudges++; mustNudge = false; nextZoomie = random(0.2, 0.4) }
          mood = 'chase'; moodTime = random(0.7, 2.2)
        }
      }
      mouth.set(0.84, 0.28, 0)
      head.localToWorld(mouth)
      if (pack) {
        const paws = legs.filter(l => !l.hind).map(l => l.paw.getWorldPosition(new THREE.Vector3()))
        pack.afterPose({ nalu: { nose, mouth, paws }, milo: milo.pose({ ...pack.dogs.milo, speed: pack.dogs.milo.travelSpeed }), rocky: rocky.pose({ ...pack.dogs.rocky, speed: pack.dogs.rocky.travelSpeed }) })
        bx = pack.ball.x; by = pack.ball.y; bz = pack.ball.z
        el.dataset.pack = JSON.stringify({ phase: pack.phase, active: pack.active, owner: pack.owner, ball: pack.ball, socialGames: pack.socialGames, greetings: pack.greetings, dogs: Object.values(pack.dogs).map(d => ({ ...d, scale: distanceScale(d.z) * dogScale(d.name) })) })
      } else if (ballState === 'pickup') {
        const t = THREE.MathUtils.smoothstep(1 - actionTime / 0.35, 0, 1)
        bx = THREE.MathUtils.lerp(pickupX, mouth.x, t)
        by = THREE.MathUtils.lerp(pickupY, mouth.y, t)
        bz = mouth.z * t
      } else if (ballState === 'carry' || (ballState === 'drop' && !released)) {
        bx = mouth.x; by = mouth.y; bz = mouth.z
        if (ballState === 'drop' && actionTime <= 0.45) {
          released = true; drops++
          vx = facing * 0.6; vy = 0
        }
      }
      ball.position.set(bx, by, bz)
      ball.rotation.z -= vx * dt / 0.23
      wolfShadow.position.set(x, .04, wolfDepth); wolfShadow.scale.x = 1.85 * wolf.scale.x / (1 + hop * 0.5)
      ballShadow.position.set(bx, .035, bz); ballShadow.scale.x = 0.3 / (1 + by * 0.3)
      el.dataset.friendsActive = String(!!pack)
      el.dataset.behavior = ballState === 'free' ? hunt === 'none' ? zoomie === 'none' ? mood : zoomie === 'out' ? 'feint' : 'zoomies' : hunt : ballState
      el.dataset.speed = String(speed)
      el.dataset.zoomies = String(zoomies)
      el.dataset.feints = String(feints)
      el.dataset.bursts = String(bursts)
      el.dataset.hunt = hunt
      el.dataset.stalks = String(stalks)
      el.dataset.pounces = String(pounces)
      el.dataset.pounceHits = String(pounceHits)
      el.dataset.jumpHeight = String(hop)
      el.dataset.ballState = ballState
      el.dataset.pickups = String(pickups)
      el.dataset.drops = String(drops)
      el.dataset.postDropNudges = String(postDropNudges)
      el.dataset.carryError = ballState === 'carry' ? String(ball.position.distanceTo(mouth)) : ''
      el.dataset.nudges = String(nudges)
      el.dataset.offscreen = String(outside)
      el.dataset.exits = String(exits)
      el.dataset.returns = String(returns)
      renderer.render(scene, camera)
    }
    function tick(now: number) {
      const dt = previous ? Math.min((now - previous) / 1000, 0.035) : 0
      previous = now
      if (!document.hidden && !reduced.matches) draw(dt)
      frame = requestAnimationFrame(tick)
    }
    toggleFriends.current = enabled => {
      pack = enabled ? new FriendsPlay(THREE.MathUtils.clamp(x, -width / 2 - 2, width / 2 + 2), THREE.MathUtils.clamp(bx, -width / 2 + 3, width / 2 - 3), reduced.matches) : null
      for (const friend of [milo, rocky]) { friend.group.visible = enabled; friend.shadow.visible = enabled }
      if (!enabled) {
        delete el.dataset.pack
        ballState = 'free'; hunt = 'none'; zoomie = 'none'; mood = 'chase'; moodTime = 2
        bz = 0; by = Math.max(.23, by); vx = 2; vy = 0; cooldown = .8; mustNudge = false
      }
      resize()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(el)
    resize()
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame); observer.disconnect()
      toggleFriends.current = () => {}
      milo.dispose(); rocky.dispose()
      scene.traverse(obj => { if (obj instanceof THREE.Mesh) obj.geometry.dispose() })
      ;[fur, furEdge, white, blue, shadowMaterial].forEach(m => m.dispose())
      renderer.dispose(); renderer.domElement.remove()
    }
  }, [])
  return <>
    <div ref={host} aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-10 z-10 h-[120px] sm:h-[150px]" data-nalu-chase="" />
    <button type="button" aria-pressed={friendsActive} aria-label="Play with friends" title={friendsActive ? 'Milo and Rocky are playing — click to play solo' : 'Invite Milo and Rocky to play with Nalu'}
      onClick={() => { const next = !friendsActive; setFriendsActive(next); toggleFriends.current(next) }}
      className="absolute bottom-3.5 left-3 z-20 flex min-h-9 items-center gap-1.5 rounded-full border border-border-gray bg-surface/95 px-2.5 text-[11px] font-medium text-primary shadow-sm backdrop-blur-md transition-colors hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:bottom-4 sm:left-5 sm:px-3 sm:text-xs">
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor"><ellipse cx="6" cy="8" rx="2.3" ry="3" transform="rotate(-25 6 8)"/><ellipse cx="11" cy="5" rx="2.2" ry="3"/><ellipse cx="17" cy="6" rx="2.2" ry="3" transform="rotate(18 17 6)"/><ellipse cx="21" cy="11" rx="2" ry="2.7" transform="rotate(28 21 11)"/><path d="M5 17c0-2 3-3 4-5s4-2 5 0 5 3 5 5-2 4-5 3-3-1-5 0-4-1-4-3Z"/></svg>
      {friendsActive ? 'Friends playing' : 'Play with friends'}
    </button>
    <span className="sr-only" role="status">{friendsActive ? 'Milo and Rocky are joining Nalu. Click Play with friends again to return to solo play.' : ''}</span>
  </>
}

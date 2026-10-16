import * as THREE from 'three'

export type FriendName = 'milo' | 'rocky'
export type DogPose = { x: number; z: number; yaw: number; speed: number; gait: number; dip: number; hop: number; leap: number; mouthOpen: boolean; mode?: string }
export type DogContacts = { nose: THREE.Vector3; mouth: THREE.Vector3; paws: THREE.Vector3[] }
export const distanceScale = (z: number) => 12 / (12 - Math.min(z, 0))
export const dogScale = (name: string) => name === 'rocky' ? .76 : 1
export const strideRate = (name: string, speed: number) => THREE.MathUtils.lerp(name === 'rocky' ? 6.1 : 4.4, name === 'rocky' ? 4.5 : 2.2, THREE.MathUtils.smoothstep(speed, 2.6, 5))

/** Colored, extruded silhouettes from the supplied side/front photographs.
 * Milo: long limbs, folded ears, white bib/blaze. Rocky: short, broad Frenchie,
 * round bat ears, short muzzle, muted grey/brown brindle. No added facial detail. */
export function createFriend(name: FriendName, scene: THREE.Scene) {
  const milo = name === 'milo'
  const group = new THREE.Group(), bodyRoot = new THREE.Group(), head = new THREE.Group()
  scene.add(group); group.add(bodyRoot); bodyRoot.add(head)
  group.name = name
  const coat = new THREE.MeshBasicMaterial({ color: milo ? 0x252526 : 0x82786e, side: milo ? THREE.DoubleSide : THREE.FrontSide })
  const edge = new THREE.MeshBasicMaterial({ color: milo ? 0x202022 : 0x655f5a })
  const marking = new THREE.MeshBasicMaterial({ color: milo ? 0xc8c5bb : 0x66635f, side: THREE.DoubleSide })
  const muzzle = milo ? marking : new THREE.MeshBasicMaterial({ color: 0x4a4745, side: THREE.DoubleSide })
  const materials = new Set<THREE.Material>([coat, edge, marking, muzzle])
  const shape = (points: number[][]) => {
    const s = new THREE.Shape()
    points.forEach(([x, y], i) => i ? s.lineTo(x, y) : s.moveTo(x, y))
    s.closePath(); return s
  }
  const softPatch = (points: number[][]) => {
    const s = new THREE.Shape(), last = points[points.length - 1]
    s.moveTo((last[0] + points[0][0]) / 2, (last[1] + points[0][1]) / 2)
    points.forEach(([x, y], i) => { const next = points[(i + 1) % points.length]; s.quadraticCurveTo(x, y, (x + next[0]) / 2, (y + next[1]) / 2) })
    s.closePath(); return s
  }
  function solid(parent: THREE.Object3D, s: THREE.Shape, depth: number) {
    const g = new THREE.ExtrudeGeometry(s, { depth, steps: 1, bevelEnabled: true, bevelThickness: .018, bevelSize: .012, bevelSegments: 2, curveSegments: 12 })
    g.translate(0, 0, -depth / 2)
    const mesh = new THREE.Mesh(g, [coat, edge]); parent.add(mesh); return mesh
  }
  function patch(parent: THREE.Object3D, s: THREE.Shape, depth: number, material = marking) {
    const meshes: THREE.Mesh[] = []
    for (const side of [-1, 1]) {
      const mesh = new THREE.Mesh(new THREE.ShapeGeometry(s, 12), material)
      mesh.position.z = side * (depth / 2 + .022); parent.add(mesh); meshes.push(mesh)
    }
    return meshes
  }
  const restHead = new THREE.Vector3(milo ? 1.02 : .83, milo ? 3.13 : 1.36, 0)
  const noseLocal = new THREE.Vector3(milo ? .98 : .82, milo ? -.18 : -.14, 0)
  const mouthLocal = new THREE.Vector3(milo ? 1.07 : .98, milo ? -.34 : -.28, 0)
  const body = new THREE.Shape()
  if (milo) {
    // The side photograph shows a deep ribcage, a smooth tucked loin, and a
    // sloping shoulder. Keep the muscle mass above the long lower legs.
    body.moveTo(-1.68, 2.22)
    body.bezierCurveTo(-1.81, 2.57, -1.59, 2.78, -1.23, 2.78)
    body.bezierCurveTo(-.73, 2.76, -.26, 2.67, .18, 2.8)
    body.bezierCurveTo(.43, 2.89, .45, 3.29, .65, 3.42)
    body.bezierCurveTo(.92, 3.51, 1.19, 3.26, 1.2, 2.98)
    body.bezierCurveTo(1.27, 2.61, 1.37, 2.16, 1.12, 1.77)
    body.bezierCurveTo(.99, 1.5, .61, 1.44, .3, 1.54)
    body.bezierCurveTo(-.12, 1.64, -.37, 1.98, -.77, 2.04)
    body.bezierCurveTo(-1.03, 2.02, -1.27, 1.75, -1.49, 1.82)
    body.bezierCurveTo(-1.69, 1.89, -1.71, 2.07, -1.68, 2.22)
  } else {
    body.moveTo(-1.3, .94)
    body.bezierCurveTo(-1.46, 1.42, -.99, 1.65, -.63, 1.56)
    body.bezierCurveTo(-.14, 1.5, .13, 1.48, .49, 1.6)
    body.bezierCurveTo(.87, 1.78, 1.14, 1.39, 1.1, .97)
    body.bezierCurveTo(.95, .5, .65, .47, .37, .52)
    body.bezierCurveTo(-.1, .38, -.44, .48, -.77, .53)
    body.bezierCurveTo(-1.07, .38, -1.31, .6, -1.3, .94)
  }
  const depth = .62
  const bodyMesh = solid(bodyRoot, body, depth)
  const skinned: THREE.Mesh[] = [bodyMesh]
  if (milo) {
    // His bib widens low on the chest; it is not a stripe painted on his flank.
    skinned.push(...patch(bodyRoot, softPatch([[1.08,2.99],[1.16,2.75],[1.17,2.47],[1.13,2.32],[1.2,2.18],[1.17,1.94],[1.03,1.8],[.96,1.77],[1.02,1.96],[.99,2.17],[1.07,2.4],[1.05,2.7]]), depth))
  } else {
    for (const points of [
      [[-1.19,1.35],[-.97,1.56],[-.73,1.53],[-.79,1.32],[-.62,1.09],[-.78,.91],[-1.05,1.07]],
      [[-.6,1.51],[-.31,1.5],[-.4,1.17],[-.16,1.03],[-.23,.71],[-.43,.53],[-.58,.73],[-.49,1.08]],
      [[-.03,1.44],[.17,1.49],[.27,1.3],[.17,1.07],[.42,.8],[.27,.57],[.02,.63],[.1,.98]],
    ]) skinned.push(...patch(bodyRoot, softPatch(points), depth))
  }
  const restGeometry = skinned.map(mesh => ({ mesh, positions: mesh.geometry.getAttribute('position') as THREE.BufferAttribute, rest: new Float32Array(mesh.geometry.getAttribute('position').array) }))
  // Bind Milo's bib to the same cap triangles as his chest. Independent
  // deformation of a painted patch can otherwise pull it outside the coat.
  const chestRest = restGeometry[0].rest
  const chestTriangles = bodyMesh.geometry.groups.filter(g => g.materialIndex === 0)
  const bibBindings = milo ? restGeometry.slice(1).map(({ positions }) => Array.from({ length: positions.count }, (_, vertex) => {
    const x = positions.getX(vertex), y = positions.getY(vertex)
    for (const cap of chestTriangles) for (let i = cap.start; i < cap.start + cap.count; i += 3) {
      const ax = chestRest[i * 3], ay = chestRest[i * 3 + 1], bx = chestRest[(i + 1) * 3], by = chestRest[(i + 1) * 3 + 1], cx = chestRest[(i + 2) * 3], cy = chestRest[(i + 2) * 3 + 1]
      const area = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
      if (Math.abs(area) < 1e-8) continue
      const a = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / area
      const b = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / area, c = 1 - a - b
      if (Math.min(a,b,c) >= -1e-5) return { i, a, b, c }
    }
    return null
  })) : []
  function headOutline(open: boolean) {
  const headShape = new THREE.Shape()
  if (milo) {
    // Broad skull and a short, blunt muzzle from the front photo. The folded
    // ears are separate flaps below the crown, so the outline has no wolf tips.
    headShape.moveTo(-.46,-.38)
    headShape.bezierCurveTo(-.6,-.14,-.59,.19,-.45,.37)
    headShape.bezierCurveTo(-.32,.52,-.04,.54,.18,.43)
    headShape.quadraticCurveTo(.33,.35,.37,.17)
    headShape.quadraticCurveTo(.51,.035,.79,.025)
    headShape.quadraticCurveTo(.98,.035,1.025,-.075)
    headShape.quadraticCurveTo(1.055,-.19,.985,-.3)
    if (open) {
      headShape.lineTo(.36,-.29); headShape.quadraticCurveTo(.42,-.51,.72,-.53)
      headShape.lineTo(.96,-.5); headShape.quadraticCurveTo(.91,-.67,.61,-.65)
      headShape.quadraticCurveTo(.17,-.64,-.04,-.47)
    } else {
      headShape.quadraticCurveTo(.96,-.39,.71,-.43)
      headShape.quadraticCurveTo(.33,-.49,-.04,-.47)
    }
    headShape.quadraticCurveTo(-.26,-.52,-.46,-.38); headShape.closePath()
  } else {
    headShape.moveTo(-.5,-.31)
    headShape.bezierCurveTo(-.65,-.06,-.59,.27,-.48,.45)
    headShape.bezierCurveTo(-.67,.81,-.56,1.07,-.42,1.1)
    headShape.bezierCurveTo(-.23,1.12,-.08,.68,-.12,.5)
    headShape.lineTo(.11,.51)
    headShape.bezierCurveTo(.11,.87,.29,1.12,.43,1.04)
    headShape.bezierCurveTo(.6,.91,.52,.55,.43,.4)
    headShape.quadraticCurveTo(.69,.25,.65,.03)
    headShape.quadraticCurveTo(.91,.03,.89,-.19)
    if (open) {
      headShape.lineTo(.4,-.18); headShape.lineTo(.56,-.43); headShape.lineTo(.82,-.4)
      headShape.quadraticCurveTo(.72,-.61,.45,-.53)
    } else headShape.bezierCurveTo(.94,-.43,.65,-.57,.45,-.46)
    headShape.quadraticCurveTo(.12,-.67,-.17,-.44)
    headShape.closePath()
  }
  return headShape
  }
  const closedHead = new THREE.Group(), openHead = new THREE.Group()
  head.add(closedHead, openHead); openHead.visible = false
  const headDepth = milo ? .65 : .6
  solid(closedHead, headOutline(false), headDepth)
  solid(openHead, headOutline(true), headDepth)
  const ears: THREE.Group[] = []
  if (milo) {
    for (const side of [-1, 1]) {
      const ear = new THREE.Group(); ear.position.set(-.24,.39,side * .34); head.add(ear)
      const flap = new THREE.Shape()
      flap.moveTo(-.12,.035); flap.bezierCurveTo(-.34,.06,-.52,-.075,-.5,-.22)
      flap.quadraticCurveTo(-.47,-.31,-.3,-.24)
      flap.bezierCurveTo(-.14,-.15,.015,-.07,.055,.005)
      flap.quadraticCurveTo(-.005,.085,-.12,.035); flap.closePath()
      solid(ear, flap, .105); ears.push(ear)
    }
    // Leave the nose black. White wraps the muzzle/chin, with a small blaze
    // on the front ridge rather than a sweeping stripe across the cheek.
    for (const [holder, open] of [[closedHead, false], [openHead, true]] as const) {
      patch(holder, open
        ? softPatch([[.53,.0],[.78,.02],[.87,-.05],[.83,-.17],[.94,-.23],[.88,-.275],[.39,-.27],[.48,-.18],[.45,-.07]])
        : softPatch([[.53,.0],[.78,.02],[.87,-.05],[.83,-.17],[.94,-.23],[.87,-.34],[.63,-.42],[.29,-.405],[.34,-.27],[.48,-.22],[.45,-.07]]), headDepth)
      if (open) patch(holder, softPatch([[.38,-.53],[.6,-.56],[.89,-.55],[.78,-.62],[.54,-.625],[.33,-.57]]), headDepth)
      patch(holder, softPatch([[.285,.35],[.34,.285],[.37,.17],[.43,.075],[.39,-.035],[.335,.08],[.305,.21]]), headDepth)
      // A few charcoal flecks suggest the ticking visible in both photographs.
      for (const [x,y,r] of [[.47,-.09,.02],[.6,-.035,.016],[.52,-.2,.014],[.69,-.19,.018],[.4,-.145,.013]]) {
        const fleck = new THREE.Shape(); fleck.absellipse(x,y,r,r*.65,0,Math.PI*2,false,0)
        for (const mesh of patch(holder, fleck, headDepth + .006, coat)) mesh.position.z += Math.sign(mesh.position.z) * .002
      }
    }
  } else {
    patch(closedHead, shape([[.48,.09],[.69,.03],[.84,-.07],[.88,-.3],[.64,-.46],[.39,-.35],[.37,-.09]]), headDepth, muzzle)
    patch(openHead, shape([[.48,.09],[.69,.03],[.84,-.07],[.87,-.16],[.44,-.17],[.37,-.09]]), headDepth, muzzle)
  }
  const tail = new THREE.Group(); tail.position.set(milo ? -1.58 : -1.25, milo ? 2.57 : 1.16, 0); bodyRoot.add(tail)
  const tailShape = new THREE.Shape()
  tailShape.moveTo(.12,.09)
  if (milo) {
    tailShape.bezierCurveTo(-.46,-.04,-.98,.015,-1.4,.27)
    tailShape.quadraticCurveTo(-1.33,.07,-1.09,-.035)
    tailShape.bezierCurveTo(-.68,-.2,-.26,-.17,.09,-.09)
  } else {
    tailShape.quadraticCurveTo(-.26,.14,-.26,-.07)
    tailShape.quadraticCurveTo(-.12,-.23,.1,-.05)
  }
  tailShape.closePath(); solid(tail, tailShape, milo ? .12 : .24)
  const hipHeight = milo ? 2.19 : .87
  const legs: { hip: THREE.Group; upper: THREE.Group; lower: THREE.Group; ankle: THREE.Group; paw: THREE.Group; hind: boolean; far: boolean; a: number; b: number }[] = []
  for (const hind of [true, false]) for (const far of [true, false]) {
    const hip = new THREE.Group(), upper = new THREE.Group(), lower = new THREE.Group(), ankle = new THREE.Group(), paw = new THREE.Group()
    hip.position.set(hind ? milo ? -1.27 : -.93 : milo ? .78 : .64, hipHeight, (far ? -1 : 1) * (milo ? .34 : .35))
    group.add(hip); hip.add(upper, lower, ankle, paw)
    const a = milo ? hind ? 1.03 : .89 : hind ? .45 : .39
    const b = milo ? hind ? .97 : 1.23 : .46
    const thick = milo ? hind ? .29 : .205 : hind ? .26 : .19
    const thigh = new THREE.Shape()
    thigh.moveTo(-thick,.2); thigh.bezierCurveTo(thick * 1.65,.24,thick * 1.22,-a * .57,.1,-a)
    thigh.lineTo(-.105,-a); thigh.bezierCurveTo(-thick,-a * .66,-thick * 1.27,-.07,-thick,.2)
    solid(upper, thigh, milo ? .19 : .26)
    const calf = new THREE.Shape()
    calf.moveTo(-.12,.07); calf.quadraticCurveTo(.17,.12,.13,-b * .38)
    calf.lineTo(.095,-b); calf.lineTo(-.09,-b); calf.quadraticCurveTo(-.17,-b * .5,-.12,.07)
    solid(lower, calf, milo ? .17 : .24)
    if (milo && hind) {
      const hock = new THREE.Shape()
      hock.moveTo(-.095,.045); hock.quadraticCurveTo(.12,.08,.095,-.15)
      hock.lineTo(.075,-.34); hock.lineTo(-.085,-.34); hock.closePath()
      solid(ankle,hock,.17)
    }
    const foot = new THREE.Shape()
    foot.moveTo(-.13,.09); foot.bezierCurveTo(.12,.15,.29,.05,.26,-.055)
    foot.quadraticCurveTo(.06,-.11,-.14,-.05); foot.closePath()
    solid(paw, foot, milo ? .22 : .29)
    if (milo) patch(paw, softPatch([[.1,.065],[.21,.04],[.265,-.005],[.23,-.06],[.08,-.06],[.125,-.018],[.09,.008]]), .22)
    legs.push({ hip, upper, lower, ankle, paw, hind, far, a, b })
  }
  const shadowMaterial = new THREE.MeshBasicMaterial({ color: 0x17202f, transparent: true, opacity: .12, depthWrite: false })
  materials.add(shadowMaterial)
  const shadow = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 8), shadowMaterial)
  scene.add(shadow)
  const contacts: DogContacts = { nose: new THREE.Vector3(), mouth: new THREE.Vector3(), paws: [new THREE.Vector3(), new THREE.Vector3()] }
  function pose(p: DogPose) {
    const bow = p.mode === 'bow' ? .18 : 0
    const scale = distanceScale(p.z) * dogScale(name), localSpeed = Math.abs(p.speed) / scale
    const moving = Math.min(1, localSpeed / 1.1), gallop = THREE.MathUtils.smoothstep(localSpeed, 2.6, 5)
    const bob = Math.sin(p.gait * 2) * .022 * moving + Math.sin(p.gait) * .045 * gallop
    group.position.set(p.x, p.hop + bob * scale, p.z); group.scale.setScalar(scale); group.rotation.y = p.yaw
    bodyRoot.rotation.z = -bow * .55
    const angle = -p.dip * (milo ? .95 : .48)
    // Rotate a broad, continuous neck into the reaching head, rather than add a stalk.
    const lowered = .25 / scale - noseLocal.x * Math.sin(angle) - noseLocal.y * Math.cos(angle)
    head.position.set(restHead.x + p.dip * .12, THREE.MathUtils.lerp(restHead.y, lowered, p.dip), 0)
    head.rotation.z = angle; openHead.visible = p.mouthOpen; closedHead.visible = !p.mouthOpen
    for (const [i, ear] of ears.entries()) {
      ear.rotation.z = -.1 + Math.sin(p.gait + i * .3) * .055 * moving
      ear.rotation.x = (i ? 1 : -1) * (.12 + Math.sin(p.gait * 2) * .035 * moving)
    }
    for (const [geometryIndex, { mesh, positions, rest }] of restGeometry.entries()) {
      for (let i = 0; i < positions.count; i++) {
        const binding = bibBindings[geometryIndex - 1]?.[i]
        if (binding) {
          const chest = restGeometry[0].positions, { i: start, a, b, c } = binding
          positions.setXYZ(i, chest.getX(start) * a + chest.getX(start + 1) * b + chest.getX(start + 2) * c,
            chest.getY(start) * a + chest.getY(start + 1) * b + chest.getY(start + 2) * c, rest[i * 3 + 2])
          continue
        }
        const x = rest[i * 3], y = rest[i * 3 + 1]
        const blend = THREE.MathUtils.smoothstep(x, milo ? -.1 : .15, milo ? 1.15 : 1)
          * THREE.MathUtils.smoothstep(y, milo ? 1.8 : .8, milo ? 2.8 : 1.5)
        const dx = x - restHead.x, dy = y - restHead.y
        positions.setXYZ(i, x + (head.position.x + dx * Math.cos(angle) - dy * Math.sin(angle) - x) * blend,
          y + (head.position.y + dx * Math.sin(angle) + dy * Math.cos(angle) - y) * blend, rest[i * 3 + 2])
      }
      positions.needsUpdate = true; mesh.geometry.computeBoundingSphere()
    }
    tail.rotation.x = Math.sin(p.gait * .55) * .18 * moving
    tail.rotation.z = (milo ? -.12 : 0) + Math.sin(p.gait) * (bow ? .24 : .07)
    legs.forEach(({ hip, upper, lower, ankle, paw, hind, far, a, b }, i) => {
      hip.position.y = hipHeight - (hind ? 0 : bow + (milo ? .14 * gallop + .16 * p.dip : 0))
      const trot = THREE.MathUtils.smoothstep(localSpeed, 1.5, 3)
      const walkingPhase = [0, .5, .25, .75][i]
      const trottingPhase = i === 0 || i === 3 ? 0 : .5
      const offset = THREE.MathUtils.lerp(THREE.MathUtils.lerp(walkingPhase, trottingPhase, trot), hind ? far ? 0 : .13 : far ? .48 : .61, gallop)
      const phase = (p.gait / (Math.PI * 2) + offset) % 1
      const stance = THREE.MathUtils.lerp(THREE.MathUtils.lerp(.68, .6, trot), .43, gallop), u = phase < stance ? phase / stance : (phase - stance) / (1 - stance)
      const stride = Math.PI * stance / strideRate(name, localSpeed) * moving
      let px = (hind ? -.11 : .025) + (phase < stance ? stride * (1 - 2 * u) : -stride * Math.cos(Math.PI * u))
      let py = -hip.position.y + .13 - bob + (phase < stance ? 0 : Math.sin(Math.PI * u) * (milo ? .32 : .19) * moving)
      if (p.mode === 'pounce') { px = hind ? -.25 : .4 + p.leap * .25; py += .17 * (1 - p.leap) }
      // Milo's rear leg has a raised hock and a short metatarsal down to the
      // paw, as visible in the standing side photograph.
      const footX = milo && hind ? .1 : 0, footY = milo && hind ? -.32 : 0
      let endX = px - footX, endY = py - footY
      const length = Math.max(.001, Math.hypot(endX, endY)), d = Math.min(a + b - .002, length)
      endX *= d / length; endY *= d / length
      px = endX + footX; py = endY + footY
      const along = (a * a - b * b + d * d) / (2 * d), bend = (hind ? 1 : -1) * Math.sqrt(Math.max(0, a * a - along * along))
      const kx = endX / d * along - endY / d * bend, ky = endY / d * along + endX / d * bend
      upper.rotation.z = Math.atan2(kx, -ky)
      lower.position.set(kx, ky, 0); lower.rotation.z = Math.atan2(endX - kx, -(endY - ky))
      ankle.position.set(endX,endY,0); ankle.rotation.z = Math.atan2(footX,-footY)
      paw.position.set(px, py, 0)
    })
    shadow.position.set(p.x, .025, p.z); shadow.scale.set((milo ? 1.9 : 1.35) * scale / (1 + p.hop), .012, .35 * scale)
    group.updateMatrixWorld(true)
    contacts.nose.copy(noseLocal); head.localToWorld(contacts.nose)
    contacts.mouth.copy(mouthLocal); head.localToWorld(contacts.mouth)
    legs.filter(l => !l.hind).forEach((l, i) => l.paw.getWorldPosition(contacts.paws[i]))
    return contacts
  }
  return { name, group, shadow, pose, contacts, dispose() {
    group.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose() })
    shadow.geometry.dispose(); materials.forEach(m => m.dispose()); group.removeFromParent(); shadow.removeFromParent()
  } }
}

// The wolf voice — shared phrase engine for every loading/thinking state.
// Combinatorial (verbs × objects × tails): 12,000+ unique lines, so the wolf
// never repeats itself. Mirrors the engine in the Nalu CLI (nalu.mjs) — keep
// the two lists in sync when adding flavor.
const WOLF_VERBS = [
  'sniffing', 'stalking', 'tracking', 'circling', 'hunting', 'shadowing', 'pawing at', 'howling at',
  'growling at', 'gnawing on', 'nosing through', 'prowling', 'padding through', 'loping across',
  'digging into', 'flushing out', 'cornering', 'herding', 'trailing', 'scenting', 'pouncing on',
  'ambushing', 'patrolling', 'ranging over', 'rooting through', 'ears pricked at', 'baring teeth at',
  'closing in on', 'running down', 'keeping watch over',
]
const WOLF_OBJECTS = [
  'the trail', 'the question', 'the details', 'fresh ideas', 'the data thicket', 'the moonlit answer',
  'stray facts', 'wild numbers', 'the research den', 'the source woods', 'loose ends', 'the long thread',
  'hidden patterns', 'the night pages', 'silent clues', 'the memory woods', 'the word forest',
  'sleeping insights', 'scattered notes', 'cold archives', 'upstream waters', 'the story line',
  'dark corners of the web', 'the answer ridge', 'tangled threads', 'the fact burrow', 'the draft clearing',
  'half-buried gems', 'the idea perimeter', 'the knowledge ridge', 'the deep stacks', 'bright sparks',
  'the daily catch', 'the big picture',
]
const WOLF_TAILS = [
  '', ' under a full moon', ' on soft paws', ' with the pack', ' ears up', ' nose to the ground',
  ' against the wind', ' at first light', ' through fresh snow', ' along the ridge',
  ' in the tall grass', ' by scent alone',
]
export const WOLF_FINISHERS = [
  'the pack has spoken', "trail's end", 'the hunt is done', 'howl delivered', 'prey secured',
  'back to the den', 'tracks covered', 'the ridge is quiet', 'scent confirmed', 'territory marked',
  'the moon approves', 'pack business concluded', 'fangs sheathed', 'one more tale for the den',
  'the forest is calm again', 'nothing left to chase', 'the alpha nods', 'ears down, job done',
  'moonlight on a clear trail', 'the howl echoes back', 'den warm, work done', 'no scent left behind',
  'the watch continues', 'good hunt',
]

const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]

/** A fresh wolf loading phrase, e.g. "stalking hidden patterns under a full moon". */
export const wolfism = (): string => `${pick(WOLF_VERBS)} ${pick(WOLF_OBJECTS)}${pick(WOLF_TAILS)}`

/** A wolf sign-off for a finished job, e.g. "the pack has spoken, ears up". */
export const wolfFinisher = (): string => `${pick(WOLF_FINISHERS)}${pick(WOLF_TAILS)}`

/** How many unique lines the engine can produce (for the curious). */
export const wolfismCount = (): number =>
  WOLF_VERBS.length * WOLF_OBJECTS.length * WOLF_TAILS.length + WOLF_FINISHERS.length * WOLF_TAILS.length

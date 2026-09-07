# The origin video, actually watched

`Watch: XV2PAHWnJN0 00:00-06:55`

Source: <https://www.youtube.com/watch?v=XV2PAHWnJN0> — Tristen O'Brien,
"I Left 10 AI Agents Alone for 3 Days." 6:55, 339 frames, 207 of them screens.

Scribed after the fact, because the first attempt at this repo worked from a
description of the video rather than the video. **The video is a showcase, not a
build log** — the author says outright he could go "another 40 minutes on how
this thing is actually built" and never does. Every implementation detail below
was read off the pixels; none of it is spoken.

---

## What the frames carry that the narration does not

### 1. Agent memory is per-agent Markdown, written on encounter

The "742 notes" screen is a wall of files named **`<agent>/MEMORY.md`** —
ashley, greg, megan, dennis, derek, frank, emily, amy, beth, sarah, laura, ryan,
andre, walt. The entries are encounter-shaped:

```
- Ran into Priya: Priya has shipped 4 things
- Ran into Greg: Greg has shipped 25 things
- Ran into Frank: Frank has not been given anything yet
- Ran into Walt: Walt is new here
```

So the social layer is not a graph or a table. It is one Markdown file per agent,
appended when agents meet, containing observations about peers. The narration
says only "they wrote 742 notes about each other."

`Watch: XV2PAHWnJN0 00:03:19`

### 2. Each agent is a directory, with a subdirectory per peer

Greg's folder, opened on screen:

```
greg/
  agent.json
  AGENTS.md
  state.json
  conversations/
  reports/
  dennis/  derek/  hollis/  iris/  nora/  pearl/  walt/  wes/
```

The per-peer subdirectories are the structural surprise — an agent's private
space contains a folder for each colleague. This is the "private prompt file"
the others opened to build their case against Greg.

`Watch: XV2PAHWnJN0 00:03:52`

### 3. The morale meter has a published rubric and an autonomous trigger

The single most useful screen in the video, and entirely absent from the audio.

> **The mark at 55 is where the culture crew steps in on its own.**

A number, and a behaviour that fires without a human. Overall was 57. Per-agent
scores were Greg 0, Ashley 29, Wes 33, Beth 36, Derek 36, Frank 36 — each shown
with its itemized inputs:

| Signal | Direction |
| - | - |
| pieces of work approved | + |
| talked with you recently | + |
| something on the calendar this week | + |
| dropped outright | − |
| sent back for changes | − |
| jobs that went nowhere | − |
| ideas turned down | − |
| carrying far more than anyone else | − |
| has never been given anything | − |
| has not spoken to you in over a week | − |

Note what the signals are made of: they are **projections of the approval
ledger and of human attention**, not sentiment. "Morale" here is a derived
metric over work outcomes and neglect.

`Watch: XV2PAHWnJN0 00:04:22-00:04:40`

### 4. Approval is three verbs, not two

The Envelope card shows `APPROVE` / `SEND BACK` / `DROP IT`, on an item with an
author and a number (`DENNIS`, `#203`, "Shop research: 10 ideas for ArrtzyArt").
The chrome around it: `VILLAGERS 23`, `WORKING 0`, `OPEN WORK 0`,
`SUBSCRIPTION Covered`, `MORALE 54`, and nav for `WHO'S WHO`, `LINE UP`,
`CALL MEETING`, `COMMAND CENTER`.

`Watch: XV2PAHWnJN0 00:02:50`

### 5. Character sheets are a 4x3 sprite grid

`UP / DOWN / LEFT / RIGHT`, three cells each. Claude picks the model and the
composition; the image generator fills the cells.

`Watch: XV2PAHWnJN0 00:05:25`

---

## Where the frames contradict the narration

The Etsy screen reads **`MATT APPROVED 34`** over 37 numbered cards with three
struck out — internally consistent at 37 − 3 = 34.

The narration and the video description both say **27**.

Frames win: 34 approved, 3 rejected. Worth knowing before anyone cites "27" as a
requirement.

`Watch: XV2PAHWnJN0 00:06:05`

---

## Against what this repo built

**Riff is not a smaller version of this. It is a different product** — which,
given the name, is the honest description rather than an excuse. The first
attempt tried to recreate the video and did it badly. What the repo became is a
riff on it: the arrangement kept, the subject changed.

The video builds a *personal multi-agent helper system*. The agents run parts of
one named person's actual life, and the roster is the whole point:

> these directors handle everything like my money, my house, my kids activities,
> my YouTube channel, my inbox, my outreach

> before I left, I gave all of my agents access to all of my connectors. That is
> my email, my calendar, a bunch more

`Watch: XV2PAHWnJN0 00:01:17, 00:02:10`

Riff founds a **fictional company**. Its README opens by asking for a company
name and a line of business, and states plainly: *"There is no roster in this
repo."* The video's roster is fixed, personal, and mapped to real life domains;
Riff's is invented at runtime by a CEO agent for a business that does not exist.

That is the requirement that did not come through. The org chart in the video is
the **skin** — a legible way to arrange assistants that already had jobs. Riff
took the skin (hierarchy, titles, approvals, hiring) as the **substance** and
built a company simulator, which is why the connectors, the life domains, and
the real Etsy shop have no counterpart here.

The second divergence is the one already known: **the walkable world never
worked well enough to keep.** That cost the spatial mechanics on top.

| From the video | In Riff |
| - | - |
| per-agent `MEMORY.md` | yes — `worldfs/world.ts`, `runtime/tools.ts`, `runtime/staff.ts` |
| approval queue | yes — `desk/src/views/Envelope.vue` |
| `SEND BACK` | yes |
| `DROP IT` | **no third verb** |
| hiring | partial — `hire` in schema/ledger/types |
| interview process | **absent** |
| town hall / call meeting | **absent** |
| morale rubric + 55 threshold | see below |
| character sheets / sprites | **absent** |
| spend cap, drafts, commons | yes |

Even inside the parts Riff did attempt, the split is not random. Everything it
kept is **non-spatial** — a ledger, a
gate, an approval queue, a shared folder, a spend cap. Everything it dropped
needed a body in a world: gathering in a town hall, walking up to a calendar and
pressing space, a sprite sheet for a character who has to be drawn walking.

### The casualty worth naming: the encounter trigger

The video's memory entries are not assignments. They are **encounters**:

```
- Ran into Priya: Priya has shipped 4 things
- Ran into Walt: Walt is new here
```

An agent writes about a peer because it *met* the peer. That is a spatial
mechanic wearing a Markdown coat, and it is what makes the 742 notes
interesting — opinions formed by chance proximity rather than by org chart.

Searched this repo for that trigger — `ran into`, `encounter`, `proximity`,
`collide` — and found no encounter semantics behind the memory writes. So the
artifact survived and the mechanic that filled it did not. If per-agent memory
is going to stay, it needs a trigger that earns the same property: agents
learning about peers they were never assigned to.

### The morale divergence is a decision, not a gap

`worldfs/world.ts` says it plainly:

> There is no schema for `commons/`. That is the point: a morale meter nobody
> asked for can only appear if inventing new state costs no migration.

That reads the video correctly at the level that matters: in the video the
morale meter was **emergent** — the agents built it unasked. Riff encodes the
*conditions for emergence* rather than shipping the feature.

The open question that follows: the video's meter came with a rubric and a
threshold that triggered a culture crew autonomously. If the meter is meant to
emerge, does the *trigger* emerge too, or does something have to be able to fire
behaviour off a number an agent invented? That is a real design question and it
is not answered anywhere in this repo.

## Rules: video vs repo

Video had five; Riff has six.

| # | Video | Riff |
| - | - | - |
| 1 | work well together | same |
| 2 | freedom, if **chief of staff** approves | freedom **inside your mandate**, **CEO** approves |
| 3 | real world, always a draft | same |
| 4 | **Matt** only, $5/day | **treasurer** only, $5.00/day |
| 5 | if I'm not around, don't stop | if the **board** is not around, do not stop |
| 6 | — | commons holds 40 documents; add one past that, remove one |

Riff generalized every proper noun into a role, and added rule 6 — a bound on
the shared space that the video never had.

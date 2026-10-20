import { AppExtensionContext, CommandContext, Outline, OutlineChange, Row, RowId } from 'bike/app'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Row attribute a task's inherited due date is written to. */
const DUE_ATTRIBUTE = 'due'

/**
 * Fallback for a hand-typed day-heading that hasn't (yet) been recognized
 * by Bike's own Calendar panel: titles like "2026-09-08 Tue" — the date
 * lives in the heading's own title text, not in a `due` attribute. This
 * pulls the leading YYYY-MM-DD out of a heading's text; anything after it
 * (weekday, notes, ...) is ignored.
 *
 * This is ONLY consulted when a row doesn't already carry a calendar day id
 * (see `dayRowDate()` below) — once a heading is recognized by Bike's own
 * Calendar panel (by double-clicking its date, or via a migration step),
 * its id takes over and this pattern no longer matters for it, whatever its
 * title says. If your day-headings use a different format and you don't use
 * Bike's Calendar panel at all, adjust this pattern (capture group 1 must
 * produce a `due`-attribute wire value: YYYY-MM-DD, or an ISO-8601 UTC
 * timestamp if you need a time component).
 */
const HEADING_DATE_PATTERN = /^\s*(\d{4}-\d{2}-\d{2})/

/**
 * Private bookkeeping attribute. Whenever this extension sets a task's due
 * date FOR it (because it's inheriting from its container day-row), it also
 * stamps this attribute `true` on that task. That's how the rule tells "I
 * set this" apart from "the user typed this in": only rows carrying this
 * marker get overwritten automatically. Type your own due date onto a task
 * and the marker falls off (see `syncTaskDue`), so your value sticks; clear
 * the due date and the marker's absence lets it re-inherit.
 *
 * Registered below with `user: false` and `defaultBadge: false`, so it never
 * appears in the Attributes settings table, suggestions, a row's log, or as
 * an inline badge on the row — it's not something anyone is meant to see or
 * set by hand.
 */
const INHERITED_ATTRIBUTE = 'inherit-due-dates-auto'

export async function activate(context: AppExtensionContext) {
  console.log('inherit-due-dates activated')

  context['inheritedAttribute'] = bike.attribute(INHERITED_ATTRIBUTE, {
    type: 'boolean',
    // Stops Bike's automatic catch-all badge from rendering this attribute
    // inline on the row. `metadata: { user: false }` (below) only keeps it
    // out of the Attributes settings table and suggestions — it doesn't
    // stop the row from displaying it, which is what defaultBadge does.
    defaultBadge: false,
    metadata: { user: false },
  })

  context['reconcile'] = bike.reconcile('inherit-due-dates', {
    when: {
      inserted: {},
      removed: {},
      // No `attribute` filter here: a day-row's date can live in its TEXT
      // (the hand-typed fallback) or its hidden `persistentId` (the
      // calendar-recognized path), so we need to wake on title edits and
      // row moves too, not just attribute writes — and a guard's self-only
      // paths can't cleanly express that as one bucket. reconcile() below
      // is cheap to no-op on irrelevant changes (see candidateTasks), so
      // waking a bit more often than strictly necessary costs little.
      modified: {},
    },
    reconcile(outline, changes) {
      const dueEdited = explicitDueEditRows(outline, changes)
      for (const task of candidateTasks(outline, changes)) {
        syncTaskDue(task, dueEdited.has(normalizeRowId(task.id)))
      }
    },
  })

  // One-time (or whenever you want a full re-check) backfill for tasks that
  // predate the extension, or that got out of sync some other way. Run it
  // from Bike's command palette: "Inherit Due Dates: Sync Whole Document".
  //
  // "Inherit Due Dates: Debug Selected Row" is a diagnostic: select a row,
  // run it, and it reports the row's type/attributes, its hidden
  // `persistentId`, the nearest ancestor day-row it found (if any) and the
  // date it read from it, and every attribute name used anywhere in the
  // document.
  //
  // "Inherit Due Dates: Preview Due-Date Tree" is a look-before-you-move
  // helper: run it on a parent-level task or heading BEFORE moving it, to
  // see which of its descendant tasks would follow the move (their due date
  // updates to match wherever you put this row) and which are anchored —
  // either to their own hand-set due date, or to a hand-dated task nested
  // inside this row's own subtree — and so would stay exactly where they
  // are no matter where you move this row. See `previewDueDateTreeCommand`
  // below. (This branch intentionally does NOT also include the automatic
  // post-move "Mixed due-date outcome" alert that `day-heading-tools` adds
  // on top of this same command — see that extension's own README if
  // you're looking for it; kept out of this minimal, general-purpose
  // distributable on request.)
  context['command'] = bike.commands.addCommands({
    commands: {
      'inherit-due-dates:sync-document': syncDocumentCommand,
      'inherit-due-dates:debug-row': debugRowCommand,
      'inherit-due-dates:preview-due-date-tree': previewDueDateTreeCommand,
    },
  })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function syncDocumentCommand(context: CommandContext): boolean {
  const outline = context.editor?.outline ?? bike.frontmostDocument?.outline
  if (!outline) return false

  outline.transaction({ label: 'Sync Inherited Due Dates' }, () => {
    for (const row of outline.root.descendants) {
      if (row.type === 'task') syncTaskDue(row)
    }
  })

  return true
}

function debugRowCommand(context: CommandContext): boolean {
  const row = context.selection?.row ?? context.editor?.selection?.row

  if (!row) {
    bike.showAlert({
      title: 'Inherit Due Dates — Debug',
      message: 'Select a row first (click into it), then run this command again.',
    })
    return true
  }

  const dayRow = containerDayRow(row)
  const sourceDue = nearestDueSource(row)
  const attributeNames = row.outline.attributeNames

  const lines = [
    `Selected row type: ${row.type}`,
    `Selected row text: ${row.text.string || '(empty)'}`,
    `Selected row attributes: ${JSON.stringify(row.attributes)}`,
    `Selected row persistentId: ${row.persistentId ?? '(none)'}`,
    '',
    dayRow
      ? `Nearest ancestor day-row: "${dayRow.text.string}" (type: ${dayRow.type}, persistentId: ${
          dayRow.persistentId ?? '(none)'
        }, date read: ${JSON.stringify(dayRowDate(dayRow) ?? null)})`
      : `Nearest ancestor day-row: NONE — no ancestor carries a calendar day id or a dated heading title.`,
    `Due date this row would inherit (nearest day-row OR nearest due-bearing ancestor task/heading): ${JSON.stringify(sourceDue ?? null)}`,
    '',
    `Every attribute name used anywhere in this document: ${attributeNames.length ? attributeNames.join(', ') : '(none)'}`,
  ]

  bike.showAlert({
    title: 'Inherit Due Dates — Debug',
    message: lines.join('\n'),
  })

  return true
}

/**
 * "Inherit Due Dates: Preview Due-Date Tree" — run on a selected
 * parent-level task or heading BEFORE moving it, to see exactly which of
 * its descendant tasks would follow the move (their due date will update
 * to match wherever you put this row) and which are anchored — either to
 * their own hand-set due date, or to a hand-dated task nested somewhere
 * inside this row's own subtree — and so would stay exactly where they are
 * no matter where you move this row.
 *
 * This exists because the two outcomes look identical until you actually
 * make the move: a parent-level row whose OWN due date is inherited
 * carries its whole un-anchored subtree with it when moved, while a
 * parent-level row whose own due date was set by hand carries nothing —
 * not even itself. Nothing in the UI distinguishes these two states at a
 * glance, so it's easy to move a row expecting one outcome and get the
 * other, especially several levels down in a big tree.
 */
function previewDueDateTreeCommand(context: CommandContext): boolean {
  const row = context.selection?.row ?? context.editor?.selection?.row

  if (!row) {
    bike.showAlert({
      title: 'Inherit Due Dates — Preview Due-Date Tree',
      message: 'Select the parent-level task or heading you\'re about to move, then run this command again.',
    })
    return true
  }

  const lines: string[] = []
  const rowLabel = row.text.string.trim() || '(untitled)'

  if (row.type === 'task') {
    const ownDue = row.getAttribute(DUE_ATTRIBUTE)
    const ownInherited = row.getAttribute(INHERITED_ATTRIBUTE) === 'true'
    if (ownDue === undefined) {
      lines.push(`"${rowLabel}" has no due date of its own.`)
    } else if (ownInherited) {
      lines.push(
        `"${rowLabel}" is due ${ownDue} — INHERITED. Moving it will update this due date to match wherever you move it, and carry along every descendant below that isn't independently anchored (see below).`
      )
    } else {
      lines.push(
        `"${rowLabel}" is due ${ownDue} — SET BY HAND. Moving it will NOT change this due date, and nothing below that currently follows it will change either.`
      )
    }
  } else {
    lines.push(`"${rowLabel}" is a ${row.type}, not a task, so it has no due date of its own — see its descendant tasks below.`)
  }
  lines.push('')

  const rowId = normalizeRowId(row.id)
  const follows: string[] = []
  const anchored: string[] = []

  for (const task of taskDescendants(row)) {
    if (normalizeRowId(task.id) === rowId) continue // row itself, already reported above
    const label = task.text.string.trim() || '(untitled task)'
    const currentDue = task.getAttribute(DUE_ATTRIBUTE)
    const ownExplicit = currentDue !== undefined && task.getAttribute(INHERITED_ATTRIBUTE) !== 'true'

    if (ownExplicit) {
      anchored.push(`"${label}" — own due date (${currentDue}), set by hand`)
      continue
    }

    const anchor = nearestExplicitAnchor(task)
    if (anchor && anchor.level >= row.level) {
      anchored.push(`"${label}" — anchored to "${anchor.text.string.trim() || '(untitled)'}"'s due date (${anchor.getAttribute(DUE_ATTRIBUTE)})`)
    } else {
      follows.push(`"${label}"${currentDue !== undefined ? ` (currently ${currentDue})` : ' (currently undated)'}`)
    }
  }

  if (follows.length === 0 && anchored.length === 0) {
    lines.push('No descendant tasks with a due date in this subtree.')
  } else {
    lines.push(`Will follow this row's move (${follows.length}):`)
    lines.push(...(follows.length ? follows.map((s) => `  • ${s}`) : ['  (none)']))
    lines.push('')
    lines.push(`Anchored — won't change no matter where you move this row (${anchored.length}):`)
    lines.push(...(anchored.length ? anchored.map((s) => `  • ${s}`) : ['  (none)']))
  }

  bike.showAlert({
    title: 'Inherit Due Dates — Preview Due-Date Tree',
    message: lines.join('\n'),
  })

  return true
}

// ---------------------------------------------------------------------------
// Reconcile rule
// ---------------------------------------------------------------------------

/**
 * Everything from this transaction's changes that might need `due` fixed up:
 * tasks under rows that were just inserted or moved, every task descendant
 * of a row whose `due`/marker attribute was just written (that row's own
 * due date change might be a NEARER source for tasks below it than
 * whatever they were previously inheriting from — see `nearestDueSource()`
 * — so they need re-checking in the same transaction, not just the row
 * itself), and — since a hand-typed day-row's date is its TITLE — every
 * task under a heading whose text just changed (or that just became/stopped
 * being a heading or task via a type change).
 */
function candidateTasks(outline: Outline, changes: OutlineChange[]): Set<Row> {
  const candidates = new Set<Row>()

  const addTaskDescendants = (row: Row) => {
    for (const descendant of row.descendantsWithSelf) {
      if (descendant.type === 'task') candidates.add(descendant)
    }
  }

  for (const change of changes) {
    switch (change.type) {
      case 'siblingsInserted':
        for (const row of change.siblings) addTaskDescendants(row)
        break

      case 'siblingsMoved':
        for (const row of change.newSiblings) addTaskDescendants(row)
        break

      case 'rowChanged': {
        const row = outline.getRowById(change.rowId)
        if (!row) break
        const rowChange = change.change

        if (rowChange.type === 'setAttribute') {
          if (rowChange.name === DUE_ATTRIBUTE || rowChange.name === INHERITED_ATTRIBUTE) {
            // Re-check the row's own descendants too, not just the row —
            // its due date may now be a nearer inheritance source for a
            // child or grandchild task than whatever day-row or ancestor
            // they were previously pulling from.
            addTaskDescendants(row)
          }
        } else if (rowChange.type === 'replacedText' || rowChange.type === 'replacedTextAndSetType') {
          // A heading's title changed — it might be a hand-typed day-row
          // whose date just changed. Re-check everything under it either
          // way. (A calendar-recognized row's date lives in its id, not its
          // text, so a title edit alone never changes ITS date — but it
          // costs nothing to re-check its descendants too.)
          if (row.type === 'heading') addTaskDescendants(row)
        } else if (rowChange.type === 'setType') {
          // Row became (or stopped being) a task or heading.
          addTaskDescendants(row)
        }
        break
      }
    }
  }

  return candidates
}

/**
 * `RowId` values name a row correctly whether they come from `Row.id` or
 * from an `OutlineChange`'s `rowId` field, but NOT necessarily as the same
 * JS number: `Row.id` is signed, while a `rowId` on a change can come back
 * as either spelling — per `outline.d.ts`, "both the signed and unsigned
 * spellings of a session id name the same row." Confirmed live: an edit on
 * a task with a large-enough internal id produced `change.rowId ===
 * 3059935392` while that same row's `Row.id` read back as `-1235031904` —
 * exactly 2^32 apart, i.e. the same 32-bit id, one spelling unsigned, the
 * other signed two's complement. A `Set<RowId>` built from one spelling and
 * checked with `.has()` against the other silently never matches, for any
 * row whose id happens to be large enough to differ between spellings
 * (small ids are unaffected, which is why this wasn't caught by earlier
 * testing on tasks that happened to have small ids). Every `RowId` this
 * file puts into a `Set` or compares against one is normalized through
 * this function first, so both spellings always collapse to the same
 * value.
 */
function normalizeRowId(id: RowId): RowId {
  return id >>> 0
}

/** Every task in `row`'s subtree, `row` itself included if it's a task. */
function taskDescendants(row: Row): Row[] {
  const result: Row[] = []
  for (const descendant of row.descendantsWithSelf) {
    if (descendant.type === 'task') result.push(descendant)
  }
  return result
}

/**
 * Ids of tasks whose `due` attribute was written directly THIS transaction —
 * Bike's own due-date picker, typing a value into the attribute inline,
 * clearing it by hand, or any other extension — as opposed to this rule's
 * own writes, which `reconcile()` never reports back (see reconcile.d.ts).
 * Any task whose id is in this set just had its due date deliberately (re)set
 * or cleared by something other than this rule; `syncTaskDue()` treats that
 * as final — see its own comment for why.
 *
 * Returns row IDs, not `Row` objects: `outline.getRowById()` doesn't
 * guarantee the same `Row` instance back on every call (Bike hands back a
 * fresh wrapper each time), so a `Set<Row>` built from one `getRowById` call
 * silently never matches a `Row` obtained from a different call — even for
 * the exact same underlying row. `RowId` is a plain number, so `Set.has()`
 * compares it correctly. Confirmed via a live transaction log: the same edit
 * that put a row in `candidateTasks()` (also via `getRowById`) produced a
 * `Set<Row>` that never contained it, which looked exactly like the fix
 * doing nothing at all, on every row it should have caught.
 */
function explicitDueEditRows(outline: Outline, changes: OutlineChange[]): Set<RowId> {
  const rowIds = new Set<RowId>()

  for (const change of changes) {
    if (change.type !== 'rowChanged') continue
    const rowChange = change.change
    if (rowChange.type === 'setAttribute' && rowChange.name === DUE_ATTRIBUTE) {
      rowIds.add(normalizeRowId(change.rowId))
    }
  }

  return rowIds
}

/**
 * The nearest ancestor row that reads as a "day row" — see `dayRowDate()`
 * for what qualifies — or undefined if this row isn't under one. Unlike a
 * plain heading search, this considers every ancestor regardless of its
 * Bike row type, since a Calendar-panel-created day row is type `body`,
 * never `heading`.
 */
function containerDayRow(row: Row): Row | undefined {
  let nearest: Row | undefined
  for (const ancestor of row.ancestors) {
    if (dayRowDate(ancestor) !== undefined && (!nearest || ancestor.level > nearest.level)) {
      nearest = ancestor
    }
  }
  return nearest
}

/**
 * The date a row names, as a `due`-attribute wire value, or undefined if it
 * doesn't read as a day row at all.
 *
 * Checked in order:
 *  1. Its hidden `persistentId` — if Bike's own Calendar panel recognizes
 *     this row as one of its own day rows (an id shaped `YYYY/MM/DD`,
 *     stamped when you double-click a date, or added by hand — see
 *     `isCalendarDayId()`), that id is authoritative and always wins,
 *     regardless of the row's Bike type or its title text. This is what
 *     makes the rule independent of your day-heading title format, your
 *     locale's date style, and Bike's calendar-title formatting setting.
 *  2. Its title text, but ONLY for an actual `heading` row — a fallback for
 *     a hand-typed day-heading Bike's Calendar panel doesn't recognize yet.
 *     See `HEADING_DATE_PATTERN`.
 */
function dayRowDate(row: Row): string | undefined {
  if (isCalendarDayId(row.persistentId)) {
    return dateFromCalendarDayId(row.persistentId!)
  }
  if (row.type === 'heading') {
    return row.text.string.match(HEADING_DATE_PATTERN)?.[1]
  }
  return undefined
}

/**
 * The due date `task` should inherit, from whichever ancestor is NEAREST to
 * supply one — a day-row's own date (`dayRowDate()`, as before), or an
 * ordinary ancestor row (heading or task, inherited or explicit) that
 * itself carries a `due` attribute. A nearer ancestor always wins over a
 * farther one, day-row or not.
 *
 * This is what makes a sub-task follow its immediate parent TASK's due date
 * when the parent's own due date changes — e.g. rescheduling "Book flights"
 * to next week pulls its sub-task "Confirm seat selection" along with it —
 * while still falling through to the day-heading above when nothing closer
 * has a due date of its own. It also means a plain organizing heading with
 * no due of its own is completely transparent to this walk: it's neither a
 * day-row nor does it carry a `due`, so the search passes straight through
 * it to whatever's next — the section's own day-heading, or one of its own
 * due-bearing descendant tasks acting as a nearer anchor for ITS children.
 * Moving that whole section under a different day-heading re-syncs every
 * inherited (or still-undated) task under it to the new day, via
 * `candidateTasks()`'s existing `siblingsMoved` handling — but any task in
 * the section that already has its own due date (explicit, or inherited
 * from a task ancestor within the section rather than from the
 * day-heading) keeps pointing at that nearer anchor and ignores the move,
 * same as it would ignore any other day-heading edit.
 *
 * Normalizes an ancestor TASK's own `due` value down to a plain
 * `YYYY-MM-DD` (matching what `dayRowDate()` already returns), because a
 * task's `due` attribute doesn't always stay in that shape — Bike's own
 * date picker can leave it as a full timestamp (`2026-12-01T07:00:00Z`).
 * Without normalizing here, that timestamp would get compared against a
 * plain-date value forever (never matching, so re-written every sync) and,
 * worse, propagated verbatim onto every descendant it becomes the source
 * for.
 */
function nearestDueSource(row: Row): string | undefined {
  let nearest: Row | undefined
  let nearestDue: string | undefined
  for (const ancestor of row.ancestors) {
    const due = dayRowDate(ancestor) ?? ancestor.getAttribute(DUE_ATTRIBUTE)?.slice(0, 10)
    if (due !== undefined && (!nearest || ancestor.level > nearest.level)) {
      nearest = ancestor
      nearestDue = due
    }
  }
  return nearestDue
}

/**
 * The nearest ancestor task that carries its OWN due date — one it was
 * given by hand, not one this extension inherited onto it (`isInherited`
 * false, `due` defined). Used by `previewDueDateTreeCommand()` to tell
 * "this task will follow row R's move" apart from "this task is anchored
 * to some hand-dated task nested inside R's own subtree, so it won't."
 *
 * A hand-dated row `R` is itself its own "nearest explicit anchor" for
 * everything under it — if `R` is the row you're about to move, compare the
 * returned row's `.level` against `R.level`: `>= R.level` means the anchor
 * is R itself or something nested inside R's subtree (won't follow R's
 * move); `< R.level` (or no anchor at all) means nothing between the task
 * and R blocks it, so it WILL follow R wherever R goes.
 */
function nearestExplicitAnchor(row: Row): Row | undefined {
  let nearest: Row | undefined
  for (const ancestor of row.ancestors) {
    if (
      ancestor.type === 'task' &&
      ancestor.getAttribute(DUE_ATTRIBUTE) !== undefined &&
      ancestor.getAttribute(INHERITED_ATTRIBUTE) !== 'true' &&
      (!nearest || ancestor.level > nearest.level)
    ) {
      nearest = ancestor
    }
  }
  return nearest
}

/**
 * True for a persistentId shaped like Bike's own Calendar panel stamps on a
 * DAY row specifically — `YYYY/MM/DD`, zero-padded, slashes, with both the
 * month and day slots non-zero. A month row (`YYYY/MM/00`), year row
 * (`YYYY/00/00`), or week row (`YYYY/00/WW`) all match the same general
 * shape but zero one or both of those slots — see `isDayId()` in the
 * Calendar panel's own source (bike-outliner/core-extensions,
 * `src/calendar.bkext/dom/protocols.ts`), reproduced here rather than
 * imported.
 */
function isCalendarDayId(id: string | undefined): boolean {
  if (!id) return false
  const match = id.match(/^\d{4}\/(\d{2})\/(\d{2})$/)
  if (!match) return false
  return Number(match[1]) > 0 && Number(match[2]) > 0
}

/** `YYYY/MM/DD` (a calendar day id) → `YYYY-MM-DD` (a `due`-attribute value). */
function dateFromCalendarDayId(id: string): string {
  return id.replace(/\//g, '-')
}

/**
 * Bring one task's `due` attribute in line with its container day-row's
 * date — unless the task has its own, user-entered due date, which always
 * wins.
 *
 * `dueWasExplicitlySet` — pass `true` when this call is happening because
 * something OTHER than this rule just wrote to the task's `due` attribute
 * THIS transaction (see `explicitDueEditRows`): Bike's own date picker,
 * typing directly into the attribute, or clearing it. That write always
 * wins, whatever it left `due` as (a new value, or nothing) — this
 * function drops the inherited-marker and returns without touching the
 * value any further.
 *
 * Without this, a task that had already been auto-dated once (so it still
 * carries the marker) could never be manually overridden or cleared: the
 * very same transaction that changed `due` would immediately see the
 * marker still set and force it straight back to the day-row's date,
 * making the new value — or the clear — impossible to keep. That's a real
 * bug, not a feature: a manually-entered due date is supposed to always
 * win, and that has to include a due date you change or remove on a task
 * that used to be auto-dated, not just one that was never auto-dated in
 * the first place.
 *
 * The date inherited comes from `nearestDueSource()` — the nearest
 * ancestor that supplies one, whether that's a day-row or another task
 * with its own due date. So a sub-task follows its immediate parent task
 * when the parent has a due date of its own, and only falls back to the
 * day-heading above when nothing closer does.
 *
 * Idempotent: safe to call on a task that's already in sync, or that has
 * nothing to inherit.
 */
function syncTaskDue(task: Row, dueWasExplicitlySet = false): void {
  if (task.type !== 'task') return

  const sourceDue = nearestDueSource(task)
  const currentDue = task.getAttribute(DUE_ATTRIBUTE)
  const isInherited = task.getAttribute(INHERITED_ATTRIBUTE) === 'true'

  if (dueWasExplicitlySet) {
    if (isInherited) task.removeAttribute(INHERITED_ATTRIBUTE)
    return
  }

  if (sourceDue === undefined) {
    // No date to inherit (no day-row or due-bearing ancestor above it). If
    // the due date currently on this task is one we set, it's now stale —
    // drop it rather than leave a due date with no source behind it. A
    // user-entered due date is left alone.
    if (isInherited) {
      task.removeAttribute(DUE_ATTRIBUTE)
      task.removeAttribute(INHERITED_ATTRIBUTE)
    }
    return
  }

  // Free to (re)inherit when there's no due date yet, or the one that's
  // there is ours from a previous sync. Anything else is a due date the
  // user typed in themselves, so it's left untouched.
  if (currentDue === undefined || isInherited) {
    if (currentDue !== sourceDue) {
      task.setAttribute(DUE_ATTRIBUTE, sourceDue)
    }
    task.setAttribute(INHERITED_ATTRIBUTE, 'true')
  }
}

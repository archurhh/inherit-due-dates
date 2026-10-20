# Changelog

## 0.3.55

- Removed the automatic "Mixed due-date outcome" alert added in 0.3.5, keeping only the on-demand Preview Due-Date Tree command. Nothing pops up unless you run a command.

## 0.3.5

- Added **Inherit Due Dates: Preview Due-Date Tree**. Run it on a parent task or heading before moving it to see which tasks below will follow the move and which are anchored.

## 0.3.4

- Fixed: a due date you set by hand could still be reverted on some tasks. Bike can report the same row id as a signed or an unsigned number, and the two weren't being matched. Affected only rows with large internal ids.

## 0.3.3

- Sub-tasks now inherit from the nearest parent task or heading that has a due date, not only from the day row.
- A parent's full timestamp due date (as Bike's date picker can leave it) is read as a plain date before it's passed down.
- Changing a task's due date now updates its sub-tasks in the same edit.

## 0.3.2

- Fixed the 0.3.1 fix, which didn't take effect: overrides and clears were still being reverted.

## 0.3.1

- A due date you set or clear by hand now wins even on a task that was already inheriting one. Previously it was reverted in the same edit.

## 0.3.0

- Day rows are recognized by their Bike Calendar id first, so day titles can be in any format or language. Hand-typed `YYYY-MM-DD` headings still work as a fallback.

## 0.2.0

- Hid the marker attribute from the Attributes settings and the row badge.

## 0.1.0

- First release: tasks inherit their due date from a `YYYY-MM-DD` day heading.

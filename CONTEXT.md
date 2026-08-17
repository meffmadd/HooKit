# HooKit

HooKit applies user-configured Hooks to Pi Events, combines their Hook Outcomes
into an Event Outcome, and requests supported Pi Effects.

## Language

**Catalog Entry**:
One named item in a Hook Catalog, either a Hook or a Preset. Hook Source and
name identify one entry regardless of kind.

**Hook**:
A Catalog Entry that subscribes to an Event and contains a shell, an owned
Action, or both. An omitted shell acts as `true`; exact `true` and `false`
remain normal Hook behavior even when optimized.
_Avoid_: Assertion, Shell Assertion, Action Handler, executable rule

**Event**:
An occurrence to which a Hook may subscribe, named by the Hook's `event` field.
Events are either Native Events or Hook Result Events.
_Avoid_: hook event, native hook, trigger

**Native Event**:
An Event originating from Pi (`tool_call`, `turn_end`, ...).

**Action**:
A declarative Pi effect owned by a Hook and selected only against that Hook's
Hook Outcome and code after the Native Event Outcome is frozen. Selection
cannot change an Event Outcome.
_Avoid_: Action Handler, reaction rule

**Effect**:
Delivery-neutral work produced in deterministic, result-major order by Hook
Evaluation. The Pi adapter delivers Effects best-effort without changing Event
Outcomes when delivery fails.

**Action Request**:
An Effect produced from a selected Action after its selectors are removed.
_Avoid_: Action execution, handler result

**Hook Result**:
The immutable result produced by one Hook Invocation. It contains the Hook
Reference, Invocation ID, Hook Outcome, code, and any owned Action or reactive
origin—not aggregate reasons; code is `null` when no exit code was obtained. It
is distinct from the Hook Result Event projected from it.
_Avoid_: Event Outcome

**Hook Outcome**:
The individual decision expressed by one Hook Result. Every Event allows `pass`;
its failure kind is `block` for `tool_call`, `patch` for `tool_result`, `cancel`
for cancellable session changes, or `report` for report-only Events.
_Avoid_: Event Outcome

**Event Outcome**:
The complete event-specific decision aggregated from the Hook Outcomes produced
for one Event. It carries Event identity and only its needed response data,
including any combined reason; every Event has one, including a minimal `pass`.
_Avoid_: Hook Outcome, Native Outcome

**`report` Outcome**:
The Hook and Event Outcome kind used when an Event can surface failure but does
not support blocking, patching, or cancellation. Feedback remains an Effect;
the outcome is distinct from Evaluation Reports and Execution Reports.

**Hook Catalog**:
The validated, merged collection of Catalog Entries available to a session.
Ambiguous names and Preset references that resolve to another Preset make the
Catalog invalid; unresolved Hook References remain valid and dangling.
_Avoid_: Assertion file, hooks repository?

**Hook Source**:
The namespace portion of Catalog Entry identity: either `local` or an
`owner/repo` source. Source and name together identify an entry.
_Avoid_: repository bucket

**Core Catalog Entry**:
An ordinary remote Catalog Entry from `meffmadd/HooKit` that carries HooKit's
stable first-party support contract. Core is a support tier, not a Hook Source
kind, default enablement, or npm distribution mode.
_Avoid_: Built-in Hook, bundled Hook

**Extras Catalog Entry**:
An ordinary remote Catalog Entry from `meffmadd/HooKit-extras` intended for
specialized, dependency-heavy, platform-specific, or incubating policies.
_Avoid_: Extended Hook, HooKit rule

**Hook Reference**:
The source-qualified text that identifies a Hook, such as `local/guard` or
`owner/repo/guard`. Catalog Entry names are non-empty and contain neither `/`
nor NUL, keeping references and identity unambiguous.

**Section**:
A structural grouping of Catalog Entries in storage or UI. A Section does not
establish entry identity and need not correspond to one Hook Source.

**Enabled Catalog Entry**:
A Hook or Preset enabled directly in the current session branch. Only direct
enablement is persisted; without saved enablement, defaults are recomputed from
the current Catalog, while saved enablement—including an empty set—overrides
defaults on resume, reload, tree navigation, forks, and clones.

**Enabled Hook**:
A Hook eligible for Hook Evaluations because it is enabled directly or through
one or more enabled Presets. Enablement paths never duplicate it, and disabling
a Preset removes only that path; Event and Filter matching determine whether it
is invoked.

**Enabled Hook Set**:
The immutable, ordered set of unique Enabled Hooks used for a Native Event and
all its Hook Result Events within one Hook Evaluation. Catalog and Preset order
determine first occurrence; later enablement changes apply to the next
Evaluation.
_Avoid_: Active Hook Set, active list, current hooks

**Filter**:
Optional criteria over bounded Event data that decide whether an Enabled Hook
applies. Fields are ANDed, arrays are any-of, strings are regular expressions,
and other scalars match exactly; a miss produces no Hook Invocation.

**Precondition**:
The optional `when` command checked inside a Hook Invocation. An ordinary false
Precondition produces no Hook Result; inability to complete it fails closed
with code `null`.

**Hook Invocation**:
One attempt to apply a Hook after its Event and Filter match. It begins when
HooKit starts the Precondition, or its shell when none exists.
_Avoid_: Run, command run, handler invocation

**Invocation ID**:
The identity shared by one Hook Invocation, its Hook Result, Action Request,
and projected Hook Result Event.
_Avoid_: Run ID

**Hook Evaluation**:
The complete decision process initiated by one Native Event. Hooks run
sequentially in Enabled Hook Set order; after the Native Event Outcome is
frozen, each Hook's Action and Hook Result Event are processed before the next
result. Separate Evaluations may overlap but never share Event Outcomes.
_Avoid_: Hook run, event run

**Hook Evaluation Outcome**:
The deeply immutable output of one Hook Evaluation, containing a non-empty
sequence of event-typed Event Outcomes in evaluation order (the Native Event
first), ordered Effects, and an optional Evaluation Report. Hook Results remain
internal to the Evaluation.
_Avoid_: Hook Evaluation Result

**Hook Result Event**:
A bounded Event projected from every Hook Result produced for a Native Event,
even when no Hook subscribes to it. It carries the Hook Reference, Invocation
ID, Hook Outcome, and code, but not the owned Action; its Invocations are
detached from the originating abort signal, produce no further Hook Result
Events, and cannot alter the originating Event Outcome.
_Avoid_: assert_result, result hook, callback event

**Execution Wave**:
The complete lifecycle of one Pi tool execution batch, from its first tool
execution start through its final tool execution end, including all its
`tool_call` and `tool_result` Hook Evaluations. It is one reporting unit whether
Pi executes its tools sequentially or in parallel.
_Avoid_: Tool batch, parallel call group

**Evaluation Report**:
The ordered accounting of started Hook shells and selected Actions from one
Hook Evaluation, including its Hook Result Events. Filter misses, false
Preconditions, and Effects without such work produce no report.

**Execution Report**:
The durable, bounded, flat reporting record shown as one transcript entry for
one non-tool Evaluation Report or all Evaluation Reports in one Execution Wave.
It uses origin annotations rather than nesting, omits live Invocation IDs, and
is absent when there is no Evaluation Report.
_Avoid_: Aggregate Result, Execution Wave Report, execution batch, merge result

**Execution Duration**:
The observed end-to-end wall-clock interval represented by an Execution Report,
including Effect delivery. For an Execution Wave it spans the first tool start
through the final tool end; for a non-tool Evaluation it spans callback entry
through completion. Incomplete Waves have no invented duration or report.
_Avoid_: Critical-path delay, processing time, summed duration

**Preset**:
A Catalog Entry containing a named list of unique Hook References. Enabling it
enables its available Hooks; unresolved references remain dangling, while
references resolving to Presets fail validation until nesting is supported.
_Avoid_: Hook group, nested policy, rule bundle

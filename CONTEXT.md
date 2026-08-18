# HooKit

HooKit runs the Hooks that you configure. The Hooks react to Pi Events. HooKit
combines the Hook Outcomes into one Event Outcome. Then HooKit requests the Pi
Effects that Pi supports.

## Language

**Catalog Entry**:
A Catalog Entry is one item in a Hook Catalog. The item is a Hook or a Preset.
The Hook Source and the name identify one entry. This is true for either kind
of item.

**Hook**:
A Hook is a Catalog Entry. The Hook subscribes to an Event. The Hook contains a
shell, an owned Action, or both. If you omit the shell, it acts as `true`. The
exact commands `true` and `false` are normal Hook behavior. This is true even
when HooKit optimizes the commands.
_Avoid_: Assertion, Shell Assertion, Action Handler, executable rule

**Event**:
An Event is an occurrence in Pi. A Hook can subscribe to the Event. The `event`
field of the Hook names the Event. An Event is a Native Event or a Hook Result
Event.
_Avoid_: hook event, native hook, trigger

**Native Event**:
A Native Event is an Event that comes from Pi. Examples are `tool_call` and
`turn_end`.

**Action**:
An Action is a declarative request for Pi work. A Hook owns the Action. HooKit
selects the Action from the Hook Outcome and the code of the owner only.
Selection happens after the Native Event Outcome is frozen. The selection
cannot change an Event Outcome.
_Avoid_: Action Handler, reaction rule

**Effect**:
An Effect is work with no delivery side effects. Hook Evaluation produces the
Effects in a fixed order. In the order, the results come first. The Pi adapter
delivers the Effects as well as it can. If delivery fails, the Event Outcomes
do not change.

**Action Request**:
An Action Request is an Effect. HooKit makes it from a selected Action. HooKit
removes the selectors before it makes the request.
_Avoid_: Action execution, handler result

**Hook Result**:
A Hook Result is the fixed result of one Hook Invocation. The result contains
the Hook Reference, the Invocation ID, the Hook Outcome, the code, and any
owned Action or reactive origin. It does not contain aggregate reasons. The
code is `null` when HooKit gets no exit code. A Hook Result is not the same as
the Hook Result Event that comes from it.
_Avoid_: Event Outcome

**Hook Outcome**:
A Hook Outcome is the decision of one Hook Result. Every Event allows the
outcome `pass`. The failure kind depends on the Event. It is `block` for
`tool_call`. It is `patch` for `tool_result`. It is `cancel` for cancellable
session changes. It is `report` for report-only Events.
_Avoid_: Event Outcome

**Event Outcome**:
An Event Outcome is the full decision for one Event. HooKit makes it from all
the Hook Outcomes for that Event. It carries the Event identity and only the
response data that it needs. The data can include a combined reason. Every
Event has one Event Outcome. A simple `pass` is an Event Outcome.
_Avoid_: Hook Outcome, Native Outcome

**`report` Outcome**:
A `report` Outcome is a Hook Outcome and an Event Outcome. Use the Outcome when
an Event can show failure. In this case the Event cannot block, patch, or
cancel. The feedback stays an Effect. This Outcome is not the same as an
Evaluation Report or an Execution Report.

**Hook Catalog**:
A Hook Catalog is a collection of Catalog Entries. HooKit validates and merges
the collection for the session. The Catalog is invalid if a name has two
meanings. It is also invalid if a Preset reference points to another Preset.
An unresolved Hook Reference stays valid and dangling.
_Avoid_: Assertion file, hooks repository?

**Hook Source**:
A Hook Source is the namespace part of the Catalog Entry identity. The Source
is `local` or an `owner/repo` source. The Source and the name together
identify one entry.
_Avoid_: repository bucket

**Core Catalog Entry**:
A Core Catalog Entry is an ordinary remote Catalog Entry from
`meffmadd/HooKit`. It carries the stable support contract from HooKit itself.
Core is a support tier. Core is not a Hook Source kind. Core is not a default
enablement. Core is not an npm distribution mode.
_Avoid_: Built-in Hook, bundled Hook

**Extras Catalog Entry**:
An Extras Catalog Entry is an ordinary remote Catalog Entry from
`meffmadd/HooKit-extras`. Use it for policies that are specialized, need many
dependencies, target one platform, or are at an early stage.
_Avoid_: Extended Hook, HooKit rule

**Hook Reference**:
A Hook Reference is the text that identifies a Hook. The text has the Source
and the name. Examples are `local/guard` and `owner/repo/guard`. A Catalog
Entry name is not empty. It contains no `/` and no NUL. This keeps the
references and the identity clear.

**Section**:
A Section is a group of Catalog Entries. HooKit uses the group in storage or in
the UI. A Section does not set the identity of an entry. A Section does not
have to match one Hook Source.

**Enabled Catalog Entry**:
An Enabled Catalog Entry is a Hook or a Preset. The current session branch
enables the entry directly. HooKit saves only direct enablement. If no
enablement is saved, HooKit recomputes the defaults from the current Catalog.
A saved set, even an empty set, overrides the defaults. This happens on
resume, reload, tree navigation, forks, and clones.

**Enabled Hook**:
An Enabled Hook can take part in Hook Evaluations. The Hook is enabled
directly, or through one or more enabled Presets. Enablement paths never
duplicate the Hook. If you disable a Preset, only that path goes away. Event
and Filter matching decide if the Hook runs.

**Enabled Hook Set**:
An Enabled Hook Set is a fixed, ordered set of unique Enabled Hooks. One Hook
Evaluation uses the set for a Native Event and all its Hook Result Events.
Catalog order and Preset order decide the first occurrence. Enablement changes
apply to the next Evaluation.
_Avoid_: Active Hook Set, active list, current hooks

**Filter**:
A Filter is optional conditions on bounded Event data. The conditions decide if
an Enabled Hook applies. All the fields must match. An array matches if one of
its members matches. A string is a regular expression. Other scalars must match
exactly. If the conditions do not match, no Hook Invocation occurs.

**Precondition**:
A Precondition is the optional `when` command. HooKit checks the command inside
a Hook Invocation. If the Precondition is false, no Hook Result occurs. If
HooKit cannot complete the Precondition, the Invocation fails closed with code
`null`.

**Hook Invocation**:
A Hook Invocation is one attempt to apply a Hook. The attempt starts when the
Event and the Filter match. It starts when HooKit runs the Precondition. If
there is no Precondition, it starts when HooKit runs the shell.
_Avoid_: Run, command run, handler invocation

**Invocation ID**:
An Invocation ID is the identity of one Hook Invocation. The Hook Result, the
Action Request, and the Hook Result Event share the same identity.
_Avoid_: Run ID

**Hook Evaluation**:
Hook Evaluation is the full decision process for one Native Event. The Event
starts the process. Hooks run one after the other in Enabled Hook Set order.
HooKit freezes the Native Event Outcome first. Then it processes the Action and
the Hook Result Event of each Hook. Two Evaluations can run at the same time.
They never share Event Outcomes.
_Avoid_: Hook run, event run

**Hook Evaluation Outcome**:
A Hook Evaluation Outcome is the fixed output of one Hook Evaluation. It
contains a non-empty sequence of event-typed Event Outcomes in evaluation
order. The Native Event comes first. It also contains ordered Effects and an
optional Evaluation Report. Hook Results stay inside the Evaluation.
_Avoid_: Hook Evaluation Result

**Hook Result Event**:
A Hook Result Event is a bounded Event. HooKit projects the Event from every
Hook Result for a Native Event. This happens even if no Hook subscribes to the
Event. The Event carries the Hook Reference, the Invocation ID, the Hook
Outcome, and the code. It does not carry the owned Action. Its Invocations
have no connection to the originating abort signal. They make no new Hook
Result Events. They cannot change the originating Event Outcome.
_Avoid_: assert_result, result hook, callback event

**Execution Wave**:
An Execution Wave is the full lifecycle of one Pi tool execution batch. It
starts at the first tool execution start. It ends at the final tool execution
end. It includes all the `tool_call` and `tool_result` Hook Evaluations in the
batch. It is one reporting unit. This is true when Pi runs the tools one after
another, and when it runs them at the same time.
_Avoid_: Tool batch, parallel call group

**Evaluation Report**:
An Evaluation Report lists the started Hook shells and the selected Actions of
one Hook Evaluation, in order. It includes the Hook Result Events. A Filter
miss makes no report. A false Precondition makes no report. Effects that make
no such work make no report.

**Execution Report**:
An Execution Report is a durable, bounded, flat record. It appears as one
transcript entry. The entry covers one non-tool Evaluation Report, or all the
Evaluation Reports in one Execution Wave. It uses origin annotations, not
nesting. It omits live Invocation IDs. There is no Execution Report when there
is no Evaluation Report.
_Avoid_: Aggregate Result, Execution Wave Report, execution batch, merge result

**Execution Duration**:
Execution Duration is the observed time of an Execution Report, start to
finish. It includes Effect delivery. For an Execution Wave, it starts at the
first tool start and ends at the final tool end. For a non-tool Evaluation, it
starts at callback entry and ends at completion. An incomplete Wave has no
invented duration and no report.
_Avoid_: Critical-path delay, processing time, summed duration

**Preset**:
A Preset is a Catalog Entry with a named list of unique Hook References. If you
enable the Preset, its available Hooks become enabled. An unresolved reference
stays dangling. A reference that points to a Preset fails validation until
nesting is supported.
_Avoid_: Hook group, nested policy, rule bundle

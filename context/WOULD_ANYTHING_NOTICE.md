# Mutation-first verification, and the spec discipline around it

Self-contained, and the authority on the verification method itself. Written to be handed to another agent on
another project; nothing below depends on any particular repo.

The one-sentence version: **a test that would still pass if the behaviour it names were broken is not
evidence, and the only way to find out is to break the behaviour and watch.**

---

## Why coverage is not the thing

Coverage answers *"did this line execute?"*. That question is satisfied by any test written from the
implementation — which is what you get whenever code and tests are authored in the same sitting by the same
author, because there is nothing to disagree with the code except the code.

Observed on one 1039-line module at **100% coverage with 47 tests**: three separate bugs of the same shape in
one function, a prefix check no test distinguished from substring matching, a test asserting the broken
outcome as though it were the contract, and a mock keyed wrongly so it never exercised the function it named.
Every one of those passed. Coverage measured effort, not correctness.

Mutation asks the question coverage cannot: **would anything notice if this changed?** That cannot be
satisfied by paraphrasing the code, because answering it requires knowing what the code is *for*.

## The loop

1. **Change the code so a named behaviour is wrong.** One behaviour per mutation.
2. **Run the suite.** Record which tests redden, and how many.
3. **Restore from a byte snapshot** (`cp` before, `cp` back, verify with `cmp`). Never `git checkout` — it
   discards uncommitted work, including other people's.
4. **Report counts per behaviour**, not a total. "29 mutations, 29 killed" hides which behaviours are
   actually defended.

A behaviour with **zero** reddening tests is a finding, not a formality. Twice here a survivor was a live
defect: a prefix match that had silently become a substring match, and a guard subsumed by later checks.

## The five traps

These are empirical. Each one produced a false "verified" in practice.

**1. A mutation that raises proves nothing.** If your edit makes the code throw before reaching the guard, the
red test is telling you about the exception, not the guard. Check *why* each test failed — you want
`AssertionError` or `DID NOT RAISE`, not `KeyError`, `NameError`, or a collection error. Re-run it
well-formed: change a value, invert a condition, `if False and …` — something that still runs.

**2. A mutation that does not exercise the guard proves nothing either.** You can aim at the wrong mechanism
and conclude a good test is vacuous. Real case: forcing an `embodied` property to `True` left a keep-rule
test green, which looked like a broken test — but the test called the presence function directly and never
routed through that property. Mutating the actual short-circuit reddened it immediately. **Before concluding
a test is weak, confirm your mutation reached the code the test depends on.**

**3. An assertion is vacuous if the fixture never supplies its subject.** A test asserting "X does not appear"
passes trivially when the fixture contains no X. Real case: a swap test placed the operation immediately
after the first setup call, where the value it asserted was legitimately absent — so the assertion held
before *and* after the fix, and encoded the bug as the contract. Fixtures must supply what the assertion
denies.

**4. A test parametrized over the constant it validates vanishes with the value it protects.** If the expected
value is read from the same constant the code reads, changing the constant changes both sides and nothing
fails. Golden values must be literals.

**5. A no-op mutation must be detected, not reported.** If your anchor does not match — a renamed symbol, a
reformatted line, a string that appears twice — you have changed nothing and the green suite means nothing.
Always `assert anchor in source` before writing, and treat a miss as an error. Real case: guessing `rfind`
where the implementation used a scanning loop; the assert caught it, and without it the result would have
been a confident false pass.

## Verifying someone else's work

**Reproduce their numbers, don't accept them.** Re-run at least the gate and one or two of their most
load-bearing mutations independently. Matching counts is cheap confidence; a mismatch is the whole point.

**Establish attribution before accepting "pre-existing".** When a report says a failure is unrelated, check:
which commit introduced the failing test, whether their diff touches it, and whether the failure message
names something they changed. Twice here the attribution was correct and once the *mechanism* given for it
was invented — same conclusion, wrong cause, which matters because the wrong cause gets fixed.

**Read the mechanism before asserting a cause.** The most reliable error in this session was concluding *why*
something failed from its symptom and writing that into a spec. Four times. Each time the correction came
from opening the file. If you are about to write "X is broken because Y", open Y first.

**Beware editable installs.** If packages are installed editable, `import pkg` reads the working tree — so
while someone else is mid-task, you are measuring *their uncommitted work*. Check `git status` before
measuring library behaviour, or read the committed revision in an isolated worktree
(`git worktree add --detach`). A finding was retracted here on the strength of code nobody had committed.

**Verify consumers, not just the thing.** Stripping vendored fixtures to their minimum was verified against
the one function that read them; two other suites loaded the same directories a different way and broke.
Checking the thing in front of you is not checking everything that reads it.

## Specs, if you write work for others to do

**Inline every must-follow rule.** The spec is the only channel to the person doing the work. Assume they
cannot see your memories, your conventions file, or this document. Repeat the traps in every spec.

**State the measured baseline and require it be re-measured.** "Gate green" is not a number. Ask for the
test count *before* the first edit, quoted.

**Say what is out of scope and why**, especially for things you noticed and deliberately left. Otherwise the
next person re-derives it, or worse, guesses at it.

**Do not specify a fix you have not read the code for.** Twice here a spec told a worker to fix a mechanism
that was already correct, or to add something that already existed. A good worker pushes back; that costs
them a round trip and costs you credibility.

**Ask for failures to be reported.** A report of "29 mutations, 29 killed" with no mention of the malformed
ones, the no-ops, or the survivors is less trustworthy than one that names them. The best reports here
included "this mutation was a no-op, re-run as follows" and "this survivor was a real defect, now fixed".

## Two structural smells worth naming

**Silent defaults hide absence.** `getattr(obj, "thing", "")` turns "unknown" into "empty", and empty is a
legal value that composes without complaint. Where a value's absence matters, make reading it fail —
`getattr` with a default only suppresses `AttributeError`, so a property raising `ValueError` propagates
through existing call sites untouched.

**Tests must not read mutable state someone regenerates.** A test that reads a live output artifact passes
until the artifact is regenerated, then fails for reasons unrelated to any code change. Snapshot the shape
into the test.

## When not to do this

Mutation testing is slow — minutes per mutation on a large suite, and a careful pass over one task can be an
hour. It earns that on load-bearing behaviour: guards, invariants, anything whose silent failure produces a
plausible-looking wrong answer. It does not earn it on formatting, on code whose failure is loud and
immediate, or on a throwaway script.

The judgement call is not "is this important" but **"if this broke silently, how long until anyone noticed?"**
Where the answer is "a long time, and the output would still look reasonable", mutate it.

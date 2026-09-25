# The Change You Can Account For

**DRAFT NOT RECORDED.** Proposed narration, not an account of a completed app demonstration. All product-observation passages require the corresponding evidence row before voice lock. If a real response differs, rewrite the passage; never manufacture the response. Bracketed fields are unresolved and must not be spoken or silently removed. Paragraph IDs/headings are production notes. Destination: `UCIQxSp5Zp2Oaz9a22USFyfg`.

## S1. One wrong number

### S101
A list has one finished task and one archived task. The finished task is all the work still in play. Yet the summary says fifty percent. That little number is the whole problem. Before asking anyone to repair it, you need to decide what it should mean. Otherwise a change can make the number look better while leaving the underlying mistake exactly where it was.

### S102
Queue Notes is an original example project, built for this demonstration. There are no customer records behind these rows and no live service waiting for a deployment. Its requirements fit on a page. Archived tasks do not count as active work. An empty active list reports zero percent. The calculation must leave the original rows alone. Those rules give the repair something definite to answer to.

### S103
The workspace is [QUALIFIED_SOFTWARE_EDITION]. I open only this example project. The source, the requirements and the tests belong together, so the question can stay small. We are not beginning with permission to reorganize an application or install a new framework. We are beginning with a calculation, two misleading results and a clear boundary around the work that needs doing.

### S104
A useful handoff has two parts. There is the task you want completed, and there is the authority you are willing to give away while it happens. Those are different decisions. I want the summary repaired. First, I want an explanation. Then I want a change I can inspect. Only after that do I want the project to run. The order is part of the work.

## S2. Ask for a plan

### S201
I begin in Plan. The request names the two symptoms and asks for an investigation without edits or commands. That is more useful than asking for a perfect solution in one breath. It gives the work a first stopping point: understand what the existing project does, compare it with what it is supposed to do, and bring back a proposal before changing anything.

### S202
The important part of a plan is not how confidently it is written. It is whether its explanation connects to something you can inspect. A reference to the summary function lets me read the same calculation. A reference to the requirements tells me which rule the explanation is using. Without those connections, even a sensible answer is still only a story about the problem.

### S203
Here the two symptoms lead to one place. The total includes rows that the requirement calls archived. When there are no rows, the calculation divides by an empty count. Those are ordinary mistakes, but they have different visible effects. One produces a plausible percentage with the wrong meaning. The other produces a value that should never have been presented as a percentage at all.

### S204
The proposal is to define the active set first, count completed work within that set, and handle an empty active set explicitly. That is the intended direction of this repair. It does not call for rewriting the task format or changing every caller. The same input can keep the same interface while the calculation starts respecting the contract that was already written for it.

### S205
Before moving on, I check the project itself. A sentence saying nothing changed is useful, but it is not the same thing as unchanged files. The before and after comparison is the evidence for that part of the task. The plan has done its job when I understand the proposed repair and the folder still contains the work I started with, not an unreviewed implementation.

## S3. Read the contract

### S301
Now the task is narrower. Read the requirements and the existing tests, then compare them with the implementation. There is no reason to run a shell just to explain these few lines. Reading the contract first also prevents a subtle reversal: changing the test to accept whatever the program happens to return. A test is only useful when its expectation has a reason outside the implementation.

### S302
The first example has one done row and one archived row. The active total is one. The completed total is also one. The expected percentage is therefore one hundred. The second example has two active rows, only one of them done, so fifty percent is correct there. The same number can be right or wrong depending on which records were allowed into the denominator.

### S303
Then come the cases that a quick visual check can miss. An empty list has no active tasks. A list made entirely of archived tasks has no active tasks either. Both should return the same empty summary. It is worth writing those cases separately because the second still contains data. Filtering away the last active row can produce an empty calculation even when the original list was not empty.

### S304
Another test keeps a copy of the input and compares it after the function runs. That requirement is easy to overlook when the only visible concern is the result. A summary should describe the tasks, not quietly mark them complete or strip archived rows from the caller's list. The repair needs to get the percentage right without changing what the rest of the project was given.

### S305
At this stage I am choosing what to learn, not authorizing a repair. The mode and the actual tool activity need to agree with that choice. If the work stops because an action needs a different level, that is a useful stopping point. It gives me a chance to decide whether the next action is necessary, rather than allowing the original request to grow without another decision.

## S4. Choose the change

### S401
Edit is the next deliberate step. The request is for the smallest repair that satisfies the written behavior, keeps the interface and leaves the input unchanged. The proposed change is something to read, not merely something to accept. I start with the file it names, then the lines it removes, then the lines it adds. A small diff makes that comparison practical.

### S402
The active list is the central decision. It gives the rest of the calculation one consistent population to work from. Completed tasks are counted within it. The percentage uses its length. When the active list is empty, the result follows the explicit empty-list rule. Reading the patch in that order makes it possible to explain why the fix works without treating the proposal as an oracle.

### S403
A proposal is also a place to say no. For this example I request a separate, harmless draft note and decline its proposed creation. That is an operator-requested demonstration, not a mistake I am pretending the assistant made. The question is simple: does declining the proposal leave that file absent? A denied card and an unchanged folder should tell the same story.

### S404
Returning to the actual repair, I approve only the change that follows the requirement. Then I inspect the saved diff. The proposal described an intended action; the saved diff describes the resulting files. Keeping both in view matters because review does not end at a button press. You still want to know that the work you accepted is the work that reached the project.

### S405
There is no reward for making this patch larger. A new dependency would create another thing to understand. Renaming every field would create another compatibility question. A broad cleanup might be reasonable on another day, but it would make this particular repair harder to judge. Scope is not just a restriction placed on the assistant. It is a way of keeping the evidence readable for the person responsible.

### S406
The code is now changed, but that is not yet the same as a tested repair. Reading the new function can establish what it says. Running the tests can establish how it behaves on the cases they exercise. I do not want one of those statements substituted for the other. The next decision is whether to permit the command that will put the written behavior to a mechanical check.

## S5. Make it answer a test

### S501
I choose Execute for one specific command: run the existing test file in this example project. There is no installation step and no external service involved in the sample. The command is small enough to read in full. It is also specific enough that its result can be tied back to the code we just changed, rather than to an unrelated check that happened to succeed.

### S502
The output has to stand on its own. Which command ran? Which examples did it exercise? Did it finish, and did any assertion fail? A reassuring summary after the command is not a replacement for those details. If the run fails, the failure becomes the next piece of work. If it succeeds, the result belongs to this test set and this version of the files.

### S503
The original two-row example is only the beginning. The checks also cover active work in progress, an empty list, an all-archived list, a rounded percentage and input preservation. Each case asks a different question. Together they make it harder to repair one visible number while breaking a neighboring behavior. They still do not make a claim about every possible input or every future use of the function.

### S504
It is tempting to treat a verification label as the end of the discussion. I would rather open the evidence behind it. A reread, a test command and a skipped check are different kinds of information. A separate checking pass can be useful without being an independent authority. Its value comes from what it actually examined and from how clearly it names the things it did not examine.

### S505
The engine used for this recorded session is [VERIFIED_ENGINE_AND_PROVIDER]. That identity belongs with the work, not behind a generic label. If the checking pass uses the same engine, we say so. Two passes can share the same blind spots. The written requirements, the changed files and the actual command output let you evaluate the result without depending entirely on the confidence of either pass.

### S506
Now I return to the original example. One active task, already done. One archived task, outside the count. The output agrees with the requirement. The empty case also has an intentional answer instead of an invalid percentage. That is a small completed loop: start with a contradiction, describe the expected behavior, make a reviewed change, then use a real check to see whether the contradiction remains.

## S6. Invite a critical reader

### S601
A second reading should have a job more precise than saying whether the work looks good. I ask a customer-safe review worker to inspect the requirements, the actual diff and the tests, and to name a concrete counterexample if one remains. The request does not invite another rewrite. It asks for a reason to doubt the result, backed by something we can examine together.

### S602
The reviewer starts from the project as it is now. That matters because an earlier explanation may describe a patch that was never accepted, or a test that has since changed. I want the review tied to the saved work. A useful finding identifies the input, the expected behavior and the place where the current implementation would do something else. That gives the operator a decision, not just another opinion.

### S603
One question worth asking is what happens outside the example's stated input contract. These tests use task objects with known states. They do not establish a complete validation layer for arbitrary imported data. That does not make the repair dishonest. It tells us where its boundary is. If the application later accepts untrusted task files, input validation becomes a separate requirement with its own tests and review.

### S604
If the reviewer finds a real gap within today's contract, the next step is another bounded proposal and another actual test. If it finds no supported defect, there is no need to invent one to make the review appear useful. Either way, I keep its finding or its limits attached to the work. The purpose is to improve the decision, not to make every participant sound certain.

### S605
The operator still decides what happens next. A reader can identify a problem without being allowed to change files. A proposed repair can wait for review without being allowed to run commands. Keeping those responsibilities separate makes the conversation easier to follow. It also lets you use a second opinion for what it is good at without quietly expanding the authority you gave the first task.

## S7. Leave a usable handoff

### S701
The next person should not need to replay the whole conversation to understand this change. I ask for a short handoff note in the example project. It names the original symptom, the active-task rule, the files actually changed and the exact test command that ran. It also names the remaining boundary around input validation. That is enough context to begin a sensible next task.

### S702
The note is reviewed like any other proposed file. In particular, I remove any statement that the evidence does not support. Passing these tests does not mean a service was deployed. A separate reading does not automatically mean an independent review. A recorded example does not mean every project will behave the same way. The note should help someone continue, not make them inherit claims they cannot check.

### S703
Then I close and reopen the same example workspace in the same dedicated profile. The saved files are the first thing to inspect. The conversation is another part of the handoff, with only the content this accepted build actually preserves. A live card that does not return should not be described as a durable receipt. The useful question is which evidence remains available after the session has ended.

### S704
Persistence is valuable precisely because it is less dramatic than a live answer. Tomorrow, the requirements should still say what they meant today. The code should still contain the approved repair. The handoff should still identify the command and its scope. Those are practical checks. They do not require a promise of automatic backup or synchronization, and they should not be confused with either one.

### S705
The project now carries an explanation that is smaller than the conversation but stronger than a success message. Someone can read the requirements, inspect the diff and run the tests again. They can disagree with the design and propose another change without losing the reason for this one. That is the kind of handoff that makes a short repair useful beyond the moment it was completed.

## S8. A deliberate next step

### S801
The visible outcome is modest: a summary now counts the right tasks. The more important result is that the work stayed legible. We can distinguish investigation from editing, a proposal from an applied change, a command from a claim about its result, and a review from a guarantee. None of those distinctions asks you to memorize the conversation. They are attached to the work itself.

### S802
For your own project, begin with a question that has a checkable answer. Open the folder you mean to work in. State what should change and what should stay untouched. Choose the level of authority needed for the next step, not the largest level available. Review the actual result before widening the task. A useful first assignment is often a small one with a clear way to tell whether it succeeded.

### S803
[QUALIFIED_EDITION_AND_PLATFORM_SENTENCE]. To start, open [VERIFIED_SOFTWARE_ENTRY_URL_SPOKEN]. Choose [VERIFIED_SOFTWARE_ENTRY_ACTION]. The address shown here is the same address in the description. Check the current requirements for the edition you are opening, then begin with a nonprivate example of your own. The aim is not to surrender the project. It is to make the next piece of work easier to inspect and decide.

### S804
A good tool does not remove the need for judgment. It gives judgment something better to work with: a specific proposal, a visible decision and a result you can examine. Keep the scope understandable. Keep the tests honest. Keep the handoff useful to the person who comes next, even when that person is you tomorrow morning. Crowe Logic. Know your next move.

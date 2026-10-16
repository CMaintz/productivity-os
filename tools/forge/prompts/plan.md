You are the plan stage of the Product Forge. Read spec.md, decisions/0001-stack.md and naming.md in this folder. The product's name is "{{NAME}}".

Write plan.md with:
- ## Milestones: 2-4 milestones, each a sentence on what works at the end of it.
- ## Tickets: the work split into tickets an agent can finish in one PR each, in this exact format:

### T1: <short imperative title>
Depends on: none (or T<n>, T<m>)
Intent: As <user>, I want <x>, so that <y>. One or two sentences.
Acceptance criteria:
- [ ] testable outcome
Scope boundaries:
- what this ticket must not touch or do
Pointers:
- spec sections, ADRs or files to read

Start with a ticket that scaffolds the repo on the chosen stack with Foundry's gate green. Every user story's acceptance criteria must be covered by some ticket. Keep tickets small and dependencies explicit. Only write files in this folder.

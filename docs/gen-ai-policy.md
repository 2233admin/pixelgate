# Generative AI policy

*A living document; it will change as the tools and the project do.*

pixelgate is built with coding agents. Most of its code, documentation, commit messages
and pull request descriptions were written by Claude Code and Codex under the maintainer's
direction, and AI reviewers comment on every pull request. This policy does not ask you to
work differently. It asks for what makes generated work reviewable: a person who answers for
it, a clear label, and evidence.

It started from [Bombadil's Generative AI Policy](https://github.com/antithesishq/bombadil/blob/main/docs/development/gen-ai-policy.md).
Bombadil allows generated code but requires people to write the documentation and all
communication. pixelgate allows both, and keeps the rest: disclosure, responsibility and
human judgment in review. Background reading: [Contributor Poker](https://kristoff.it/blog/contributor-poker-and-ai/)
by Loris Cro, and the Rust project's [LLM usage policy](https://forge.rust-lang.org/policies/llm-usage.html).

## You answer for what you submit

- Read every line of your change before you open the pull request. You should be able to
  explain any line when a reviewer asks, without asking the model again.
- "The agent wrote that" does not answer a review comment.
- Keep the change to what the pull request says it does. Agents drift: they refactor
  nearby code, rename things, reformat files and delete comments nobody asked them to touch.
  Take that out before you submit.

## Say what you used

State it in the pull request description; the template has a field for it. One line is
enough: "Generated with Claude Code", "Code by Codex, reviewed and edited by hand", or "No AI
used". Commits an agent made keep its `Co-Authored-By` trailer.

## Evidence, not claims

Agents report success they never checked. In a pull request, every "tested", "fixed" or
"verified" needs the command and what it printed: the test command and its pass count, the
reproduction before and after, the pixelgate report for a visual change. If you did not run
something, say so. A claim without evidence counts as not done.

## Code

- Follow the style of the code around your change. A behavior change comes with a test; the
  e2e tests run real browsers, so most behavior can be tested.
- Comments say why, not what. Delete generated comments that narrate the code. Leave existing
  comments alone unless your change makes them wrong.
- Check every dependency an agent adds: that it exists, is the package you meant (names that
  look right are a known attack), is maintained, and is on its latest release (see
  [Development](../README.md#development)).

## Documentation

Generated documentation is fine, held to the same bar as code. Check every option, default
and command against the source and run the examples. Write for the reader: short, concrete,
no padding. Expect the maintainer to cut text that does not earn its place.

## Communication

Issues, pull request descriptions and review replies can be drafted with AI, but they must
say what you think and you must have checked them. Put long generated analysis, such as a
root-cause report or a log summary, in a `<details>` block that names the tool:

    <details>
      <summary>Claude's analysis of the flaky capture</summary>
      ...
    </details>

Do not open issues or pull requests in bulk from an agent run. Read and check each one first.

## Review

AI reviewers comment on pull requests here. Treat their comments as input: answer a bot's
finding as you would a person's, either by fixing it or by saying why not. A bot's approval
is not an approval. The maintainer reads the change and decides.

## Applicability

Much of this cannot be enforced. As the Rust policy puts it, the aim is to remove plausible
deniability, not to catch every violation. Maintainers may ask for changes to, or close, a
pull request or issue that ignores this policy: no disclosure, claims without evidence, or
changes the submitter cannot explain.

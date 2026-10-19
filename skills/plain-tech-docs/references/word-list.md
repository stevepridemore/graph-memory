# Plain-tech-docs word list

`scripts/check_docs.py` reads this file. Each `## ` heading is a category,
and each `- ` bullet under it is one pattern, matched case-insensitively on
word boundaries. Text after ` -> ` is the suggested fix shown in the report.
A bullet that starts with `re:` is a Python regular expression instead of a
literal phrase.

## inflated-word

- delve -> look at, cover
- leverage -> use
- utilize -> use
- utilise -> use
- seamless -> (cut, or say what actually happens)
- seamlessly -> (cut)
- robust -> (say what it survives: retries, bad input, restarts)
- cutting-edge -> (cut)
- state-of-the-art -> (cut)
- empower -> let, allow
- harness -> use
- unlock -> enable, allow
- elevate -> improve
- streamline -> simplify, speed up
- facilitate -> help, allow
- comprehensive -> full, complete (or cut)
- holistic -> (cut)
- synergy -> (cut)
- paradigm -> model, approach
- ecosystem -> (name the actual tools)
- landscape -> (cut)
- realm -> area
- tapestry -> (cut)
- testament -> (cut)
- pivotal -> key, important
- crucial -> important (or cut)
- vital -> important (or cut)
- myriad -> many
- plethora -> many
- embark -> start
- endeavor -> work, effort
- meticulous -> careful
- meticulously -> carefully
- bespoke -> custom
- supercharge -> speed up
- game-changer -> (cut)
- game-changing -> (cut)
- revolutionize -> change
- transformative -> (cut)
- effortless -> easy (or cut)
- effortlessly -> (cut)
- powerful -> (say what it does)
- intuitive -> (say how it works)
- elegant -> (cut)

## filler-phrase

- it's worth noting that -> (cut)
- it is worth noting that -> (cut)
- it's important to note that -> (cut)
- it is important to note that -> (cut)
- in today's -> (cut)
- let's dive in -> (cut)
- dive into -> look at
- deep dive -> walkthrough, detailed look
- in conclusion -> (cut)
- in summary -> (cut)
- at the end of the day -> (cut)
- when it comes to -> for
- in order to -> to
- a wide range of -> many
- a variety of -> several, many
- plays a crucial role -> (say what it does)
- plays a key role -> (say what it does)
- whether you're -> (cut, address the reader directly)
- look no further -> (cut)
- rest assured -> (cut)
- out of the box -> by default
- under the hood -> internally
- best practices -> (name the practice)
- take it to the next level -> (cut)
- re:\bnot (just|only) [^.]{1,60}?,? but (also )?\b -> (state the point once)
- re:\bthis (ensures|allows|enables) -> (name the subject and what happens)

## hedge

- simply -> (cut)
- just -> (cut when it means "only" to minimize effort)
- easily -> (cut)
- basically -> (cut)
- essentially -> (cut)
- actually -> (cut)
- very -> (cut or use a stronger word)
- really -> (cut)
- quite -> (cut)
- arguably -> (cut)
- generally speaking -> (cut)

## punctuation

- re:— -> use a comma, colon, parentheses, or two sentences
- re:(?<![-!<]) -- (?!>) -> use a comma, colon, or two sentences
- re:!(?=\s|$) -> drop the exclamation mark

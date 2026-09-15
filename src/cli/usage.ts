/**
 * What `wb` does, as `wb --help` prints it.
 *
 * Its own module so that the documentation can read it without importing the command
 * line, which runs itself on import. One list, printed to a terminal and rendered into
 * `docs/reference.md`, so the two cannot disagree.
 */
export const USAGE = `
workbench — a board of tickets that agents work through

  wb init [dir]                start a workbench in a repository, in .workbench/
  wb auth                      whether the workbench can reach the model service
  wb update                    fetch whatever has been pushed since this copy was installed
  wb serve                     run the workbench: the API and the orchestrator
  wb new <title> [body]        write a ticket down, in the backlog
  wb new --from <id> <title> [body]
                               carry on from a ticket, starting on its branch
  wb new --on <branch|#n|url> <title> [body]
                               work on a branch you do not own, and push the result back to it
  wb new --no-approval <title> [body]
                               let its plan go straight on to being built
  wb new --after <a,b> <title> [body]
                               hold it until those tickets offer their work, then build on it
  wb edit <id> <title> [body]  rewrite it; the instructions are left alone if omitted
  wb edit --no-approval <id>   let its plan go straight on to being built, while one is still ahead
  wb edit --approval <id>      have its plan stop for you again
  wb queue <id>                commit to it: the workbench may now start it
  wb backlog <id>              take it back out of the queue, before it starts
  wb move <id> [before]        put it in front of another ticket, or last
  wb wait <id> <a,b|none>      hold it until those tickets offer their work, then build on it
  wb list                      show every ticket and where it is
  wb show <id>                 one ticket, with everything that happened to it
  wb approve <id>              approve a plan, letting implementation start
  wb reject <id> <reason>      send it back to be planned again; the reason goes to the plan
  wb changes <id> <text>       keep the work and put these right; back to implement
  wb answer <id> <text>        answer a blocked ticket and let it carry on
  wb restart <id>              run a failed stage again, from the top
  wb continue <id>             carry on a stage the workbench stopped, keeping its run
  wb ship <id>                 offer what it has as a pull request, and decide there
  wb merge <id>                merge the offered work onto the base and accept it
  wb cancel <id> [why]         stop a ticket, including one that is running
  wb stop                      stop the whole workbench; again to interrupt what is running
  wb start                     let it work again
  wb wip <n>                   how many tickets may run at once

Every command except "init", "auth", "update" and "serve" talks to a running
workbench over HTTP, so the board and this command line can do exactly the same
things.

"wb serve" calls real agents and spends real money.
`.trim();

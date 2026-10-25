#!/usr/bin/env bash
# Creates a throwaway repository with several branches, authors and a pending merge conflict,
# for trying out Git Merge Studio:  scripts/make-demo-repo.sh /tmp/gw-demo && code /tmp/gw-demo
set -euo pipefail
dir="${1:?usage: make-demo-repo.sh <directory>}"
rm -rf "$dir"
mkdir -p "$dir"
cd "$dir"
git init -q -b main
git config user.name "Demo User"
git config user.email "demo@example.com"

as() { # as "Name" "email" -- git args...
  local name="$1" email="$2"
  shift 3
  GIT_AUTHOR_NAME="$name" GIT_AUTHOR_EMAIL="$email" GIT_COMMITTER_NAME="$name" GIT_COMMITTER_EMAIL="$email" git "$@"
}

cat > app.py <<'PY'
def greet(name):
    return "Hello, " + name


def add(a, b):
    return a + b


def main():
    print(greet("world"))
    print(add(2, 3))


if __name__ == "__main__":
    main()
PY
printf '# Demo\n\nA demo project for trying Git Merge Studio.\n\n## Features\n\n- greetings\n- addition\n- shouting\n\n## License\n\nMIT\n' > README.md
git add . && as "Demo User" demo@example.com -- commit -qm "Initial commit"

mkdir -p src/utils
printf 'export const VERSION = "1.0";\n' > src/utils/version.ts
git add . && as "Alice Smith" alice@example.com -- commit -qm "Add version module"

git checkout -qb feature/greeting
sed -i.bak 's/return "Hello, " + name/return f"Hi there, {name}!"/' app.py && rm app.py.bak
git commit -qam "Friendlier greeting" --author="Bob Lee <bob@example.com>"
printf 'def shout(text):\n    return text.upper()\n' > shout.py
git add . && git commit -qm "Add shout helper" --author="Bob Lee <bob@example.com>"
sed -i.bak 's/print(add(2, 3))/print(add(40, 2))/' app.py && rm app.py.bak
git commit -qam "Use the answer in the demo" --author="Bob Lee <bob@example.com>"

git checkout -q main
sed -i.bak 's/return "Hello, " + name/return "Welcome, " + name + "."/' app.py && rm app.py.bak
sed -i.bak 's/    return a + b/    """Add two numbers."""\n    return a + b/' app.py && rm app.py.bak
git commit -qam "Formal welcome and docstring" --author="Alice Smith <alice@example.com>"
git mv README.md README.markdown
printf '\nRun with `python app.py`.\n' >> README.markdown
git add . && as "Alice Smith" alice@example.com -- commit -qm "Rename README and add usage"
git tag v1.0

git checkout -qb hotfix/typo
printf 'export const VERSION = "1.0.1";\n' > src/utils/version.ts
git commit -qam "Bump version to 1.0.1" --author="Carol Diaz <carol@example.com>"
git checkout -q main

# Leave the repo mid-merge with a conflict in app.py.
git merge feature/greeting -q -m "Merge feature/greeting" || true
git status --short

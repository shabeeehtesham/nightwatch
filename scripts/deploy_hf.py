"""Deploy to a Hugging Face Docker Space.

Reads HF_TOKEN and the feed API keys from .env, creates the Space if
needed, stores the keys as Space *secrets* (never in the uploaded files),
and uploads the app. The Space README needs a YAML header that GitHub
would render as an ugly table, so it's generated here rather than kept in
the repo.

    python scripts/deploy_hf.py [space-name]
"""

import sys
from pathlib import Path

from dotenv import dotenv_values
from huggingface_hub import HfApi

ROOT = Path(__file__).resolve().parents[1]
SECRETS = ("AISSTREAM_API_KEY", "WINDY_API_KEY", "YOUTUBE_API_KEY")

SPACE_HEADER = """---
title: NIGHTWATCH
emoji: 🛰️
colorFrom: green
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
short_description: Live OSINT globe built from public data feeds
---

"""


def main() -> None:
    env = dotenv_values(ROOT / ".env")
    token = env.get("HF_TOKEN")
    if not token:
        sys.exit("HF_TOKEN missing from .env")

    api = HfApi(token=token)
    user = api.whoami()["name"]
    repo_id = f"{user}/{sys.argv[1] if len(sys.argv) > 1 else 'nightwatch'}"

    api.create_repo(repo_id, repo_type="space", space_sdk="docker", exist_ok=True)

    for name in SECRETS:
        if env.get(name):
            api.add_space_secret(repo_id, name, env[name])
            print(f"secret set: {name}")

    readme = SPACE_HEADER + (ROOT / "README.md").read_text(encoding="utf-8")
    api.upload_file(path_or_fileobj=readme.encode(), path_in_repo="README.md", repo_id=repo_id, repo_type="space")
    api.upload_folder(
        folder_path=ROOT,
        repo_id=repo_id,
        repo_type="space",
        allow_patterns=["app/**", "Dockerfile", "requirements.txt", "docs/preview.png"],
        ignore_patterns=["**/__pycache__/**", "*.pyc"],
        commit_message="Deploy from local repo",
    )
    print(f"https://huggingface.co/spaces/{repo_id}")


if __name__ == "__main__":
    main()

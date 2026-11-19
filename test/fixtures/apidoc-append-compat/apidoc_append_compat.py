#!/usr/bin/env python3
"""Synthetic apiDoc-shaped CLI used by the skill-script regression tests.

This is a self-contained compatibility fixture. It is not the Axon apiDoc
parser and is not derived from any external project source; it only keeps the
CLI contract the regression needs: argparse append flags, local file input,
JSON on stdout, and real filtering of apiDoc-shaped articles.
"""
import argparse
import json
import re
import sys

ARTICLE = re.compile(
    r'\{id:"(?P<id>[^"]+)",group:"(?P<group>[^"]+)",name:"(?P<name>[^"]+)",'
    r'version:"[^"]*",type:"(?P<method>[^"]+)",url:"(?P<path>[^"]+)"\}'
)


def load_articles(source):
    with open(source, encoding="utf-8") as handle:
        text = handle.read()
    return [
        {key: match.group(key) for key in ("id", "group", "name", "method", "path")}
        for match in ARTICLE.finditer(text)
    ]


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--group", action="append", default=[])
    parser.add_argument("--method", action="append", default=[])
    parser.add_argument("--path-prefix", action="append", default=[], dest="path_prefix")
    parser.add_argument("--path", default=None)
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    articles = load_articles(args.source)
    methods = {value.upper() for value in args.method}
    selected = [
        article
        for article in articles
        if (not args.group or article["group"] in args.group)
        and (not methods or article["method"].upper() in methods)
        and (not args.path_prefix
             or any(article["path"].startswith(prefix) for prefix in args.path_prefix))
        and (args.path is None or article["path"] == args.path)
    ]
    result = {
        "status": "success",
        "filters_applied": {
            "group": list(args.group),
            "method": list(args.method),
            "path_prefix": list(args.path_prefix),
            "path": args.path,
        },
        "articles": selected,
    }
    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())

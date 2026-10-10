"""Django's command line for the Django systems, such as `uv run python manage.py migrate --database lb01`."""

import os
import sys


def main() -> None:
    """Run the Django command named on the command line, with the production settings by default."""
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
    from django.core.management import execute_from_command_line

    execute_from_command_line(sys.argv)


if __name__ == "__main__":
    main()

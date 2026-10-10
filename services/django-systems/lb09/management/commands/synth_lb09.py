"""`manage.py synth_lb09` (`just tts-lb09`): speak LB-09's scripted meetings into audio, with an offline text-to-speech.

It reads the scripts in data/seed/lb09, speaks each with Flite (no network, nothing leaves the machine), and writes
one MP3 a meeting and a manifest into data/seed/lb09/audio, which are committed. `--meeting` makes only the
meetings it names. `--check` makes nothing and says whether the committed audio still matches its manifest and the
scripts, which is what CI runs. Without Flite installed the command says so and leaves the audio as it was.
"""

from argparse import ArgumentParser

from django.core.management.base import BaseCommand, CommandError

from core.data_files import DataFileError
from lb09.scripts import Script, read_scripts
from lb09.tts import SpeechEngineError, audio_dir, check_audio, find_flite, read_manifest, synthesise


class Command(BaseCommand):
    """Makes the scripted meetings into audio."""

    help = "Speak the scripted meetings with an offline text-to-speech and write the audio and its manifest."

    def add_arguments(self, parser: ArgumentParser) -> None:
        """Take the meetings to speak, and the option that only checks the committed audio."""
        parser.add_argument("--meeting", action="append", default=[], help="Speak this meeting; repeat for more.")
        parser.add_argument("--check", action="store_true", help="Make nothing: check the audio against its manifest.")

    def handle(self, *args: object, **options: object) -> None:
        """Check the committed audio, or speak the chosen meetings and say what was written."""
        try:
            scripts = read_scripts()
        except DataFileError as error:
            raise CommandError(str(error)) from None
        if options["check"] is True:
            self.verify(scripts)
            return
        chosen = [str(key) for key in options["meeting"]] if isinstance(options["meeting"], list) else []
        unknown = sorted(set(chosen) - set(scripts))
        if unknown:
            raise CommandError(f"No script is called {', '.join(unknown)}.")
        wanted = {key: scripts[key] for key in (chosen or scripts)}
        try:
            manifest = synthesise(wanted, audio_dir(), find_flite())
        except SpeechEngineError as error:
            raise CommandError(str(error)) from None
        for key, entry in manifest.meetings.items():
            self.stdout.write(f"{key}: {entry.seconds:.1f} s, {entry.bytes:,} bytes")
        self.stdout.write(f"Written to {audio_dir()} with {manifest.engine}.")

    def verify(self, scripts: dict[str, Script]) -> None:
        """Fail with each disagreement between the committed audio, its manifest and the scripts."""
        try:
            problems = check_audio(scripts)
            manifest = read_manifest()
        except DataFileError as error:
            raise CommandError(str(error)) from None
        if problems:
            raise CommandError("The committed audio is out of step:\n- " + "\n- ".join(problems))
        self.stdout.write(f"The audio of {len(scripts)} meetings matches its manifest ({manifest.engine}).")

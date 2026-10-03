"""`manage.py wer_lb09` (`just wer-lb09`): measure a transcriber's word error rate on the committed meetings.

Each meeting's committed audio (data/seed/lb09/audio) is decoded and transcribed in fast mode (through the
gateway, as a synthetic run) or private mode (`--mode private`, faster-whisper on this machine), and the words
heard are compared with the script's words (lb09/wer.py). It needs the audio and a real model, so it has not
been run where there was neither; the datasheet claims no number until it has.
"""

from argparse import ArgumentParser
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from core.data_files import DataFileError
from lb09.audio import AudioRefusedError, decode_recording
from lb09.pipeline import connect_pipeline
from lb09.scripts import read_scripts
from lb09.transcribers import TranscriberError
from lb09.tts import audio_dir, read_manifest
from lb09.wer import word_error_rate
from lb_common.run import Run, new_run_id, run_scope


class Command(BaseCommand):
    """Measures a transcriber on the committed audio."""

    help = "Transcribe each committed meeting and report the word error rate against its script."

    def add_arguments(self, parser: ArgumentParser) -> None:
        """Take the mode and the meetings to measure."""
        parser.add_argument("--mode", choices=["fast", "private"], default="fast", help="Which transcriber runs.")
        parser.add_argument("--meeting", action="append", default=[], help="Measure this meeting; repeat for more.")

    def handle(self, *args: object, **options: object) -> None:
        """Transcribe the chosen meetings and print each one's rate and the total."""
        try:
            scripts = read_scripts()
            manifest = read_manifest()
        except DataFileError as error:
            raise CommandError(str(error)) from None
        chosen = [str(key) for key in options["meeting"]] if isinstance(options["meeting"], list) else []
        unknown = sorted(set(chosen) - set(scripts))
        if unknown:
            raise CommandError(f"No script is called {', '.join(unknown)}.")
        try:
            pipeline = connect_pipeline()
        except (ValueError, OSError) as error:
            raise CommandError(f"Can't reach the gateway: {error}") from None
        transcriber = pipeline.transcribers[str(options["mode"])]
        errors = 0
        words = 0
        for key in chosen or sorted(scripts):
            path: Path = audio_dir() / manifest.meetings[key].file
            try:
                decoded = decode_recording(path)
                with run_scope(Run(system="lb-09", run_id=new_run_id(), data_class="synthetic")):
                    transcript = transcriber.transcribe(decoded.pcm, "en")
            except (AudioRefusedError, TranscriberError) as error:
                raise CommandError(f"{key}: {error}") from None
            said = " ".join(turn.text for turn in scripts[key].turns)
            measured = word_error_rate(said, transcript.text())
            errors += measured.errors
            words += measured.reference_words
            self.stdout.write(
                f"{key}: WER {measured.rate:.3f} "
                f"({measured.errors} edits over {measured.reference_words} words, {transcript.model})"
            )
        self.stdout.write(f"Overall WER {errors / words if words else 0.0:.3f} in {options['mode']} mode.")

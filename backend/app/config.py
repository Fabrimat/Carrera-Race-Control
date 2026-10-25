"""Process configuration from the environment / ``.env`` (pydantic-settings).

``.env`` is read from the repo root and from ``backend/`` (the latter wins). API keys are
``SecretStr``: never logged and never returned by the API (only "configured" booleans).
Empty values (``ELEVENLABS_API_KEY=``) count as unset.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_DIR.parent

TrackMode = Literal["simulator", "ble", "serial"]


class AppConfig(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(REPO_ROOT / ".env", BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        env_ignore_empty=True,
        extra="ignore",
    )

    elevenlabs_api_key: SecretStr | None = None
    elevenlabs_voice_id: str | None = None
    elevenlabs_model_id: str | None = None  # None -> the TTS client's default (Flash v2.5)
    anthropic_api_key: SecretStr | None = None
    anthropic_model: str = "claude-haiku-5-5"

    track_mode: TrackMode = "simulator"
    track_address: str | None = None
    commentary_lang: Literal["en", "it"] = "it"  # default for a fresh settings DB

    data_dir: Path = BACKEND_DIR / "data"  # SQLite file + TTS cache
    sim_cars: int = Field(default=4, ge=1, le=6)
    sim_time_scale: float = Field(default=1.0, gt=0)
    # Optional: in "simulator" mode replay this recorded JSONL session instead (loops).
    replay_file: Path | None = None

    # Comma-separated list of origins allowed by CORS (dev: the Vite server).
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    # Comma-separated Host names accepted (DNS-rebinding guard); ports are ignored.
    allowed_hosts: str = "127.0.0.1,localhost"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "carrera.sqlite3"

    @property
    def tts_cache_dir(self) -> Path:
        return self.data_dir / "tts_cache"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def allowed_host_list(self) -> list[str]:
        return [h.strip() for h in self.allowed_hosts.split(",") if h.strip()]

    @property
    def track_mode_explicit(self) -> bool:
        """True when TRACK_MODE was set in the environment / .env (not the default)."""
        return "track_mode" in self.model_fields_set

    def has_elevenlabs_key(self) -> bool:
        return bool(self.elevenlabs_api_key and self.elevenlabs_api_key.get_secret_value())

    def has_anthropic_key(self) -> bool:
        return bool(self.anthropic_api_key and self.anthropic_api_key.get_secret_value())

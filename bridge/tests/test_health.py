from grove_bridge.health import readiness_label


def test_readiness_label_identifies_bridge() -> None:
    assert readiness_label() == "grove-bridge ready"

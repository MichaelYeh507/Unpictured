#include "FreeFlyPlayerController.h"

AFreeFlyPlayerController::AFreeFlyPlayerController()
{
	bShowMouseCursor = true;
}

void AFreeFlyPlayerController::BeginPlay()
{
	Super::BeginPlay();

	// Game-and-UI mode captures the mouse only while a button is down and hides the cursor meanwhile.
	FInputModeGameAndUI Mode;
	Mode.SetHideCursorDuringCapture(true);
	Mode.SetLockMouseToViewportBehavior(EMouseLockMode::LockOnCapture);
	SetInputMode(Mode);
}

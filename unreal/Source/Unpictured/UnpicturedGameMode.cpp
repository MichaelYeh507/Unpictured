#include "UnpicturedGameMode.h"

#include "FreeFlyPawn.h"
#include "FreeFlyPlayerController.h"

AUnpicturedGameMode::AUnpicturedGameMode()
{
	DefaultPawnClass = AFreeFlyPawn::StaticClass();
	PlayerControllerClass = AFreeFlyPlayerController::StaticClass();
}

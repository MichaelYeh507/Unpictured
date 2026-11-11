#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"

#include "UnpicturedGameMode.generated.h"

/** Gives every player a free-fly camera and the controller that frees the mouse between drags. */
UCLASS()
class UNPICTURED_API AUnpicturedGameMode : public AGameModeBase
{
	GENERATED_BODY()

public:
	AUnpicturedGameMode();
};

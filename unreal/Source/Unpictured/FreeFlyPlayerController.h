#pragma once

#include "CoreMinimal.h"
#include "GameFramework/PlayerController.h"

#include "FreeFlyPlayerController.generated.h"

/** Keeps the mouse cursor free; the game only takes the mouse while a button is held (the drag that looks around). */
UCLASS()
class UNPICTURED_API AFreeFlyPlayerController : public APlayerController
{
	GENERATED_BODY()

public:
	AFreeFlyPlayerController();

protected:
	virtual void BeginPlay() override;
};

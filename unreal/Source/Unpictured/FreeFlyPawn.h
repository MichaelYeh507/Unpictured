#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Pawn.h"
#include "InputCoreTypes.h"

#include "FreeFlyPawn.generated.h"

class UCameraComponent;
class UEnhancedInputLocalPlayerSubsystem;
class UFloatingPawnMovement;
class UInputAction;
class UInputMappingContext;
struct FInputActionValue;

/**
 * A first-person camera that flies freely, with the web viewer's controls: hold the left mouse
 * button and drag to look, W A S D to move, E up, Q down, Shift to go faster. It has no collision.
 * Its keys are built in code at possession time, so the project needs no input assets.
 */
UCLASS()
class UNPICTURED_API AFreeFlyPawn : public APawn
{
	GENERATED_BODY()

public:
	AFreeFlyPawn();

	virtual void SetupPlayerInputComponent(UInputComponent* PlayerInputComponent) override;
	virtual void UnPossessed() override;

	/** Flying speed without Shift, in centimeters per second. */
	UPROPERTY(EditAnywhere, Category = "Free Fly")
	float Speed = 300.0f;

	/** How many times faster Shift makes the flight. */
	UPROPERTY(EditAnywhere, Category = "Free Fly")
	float FastMultiplier = 5.0f;

	/** Degrees turned per pixel of mouse drag. */
	UPROPERTY(EditAnywhere, Category = "Free Fly")
	float LookDegreesPerPixel = 0.11f;

protected:
	virtual void BeginPlay() override;

private:
	UPROPERTY(VisibleAnywhere, Category = "Free Fly")
	TObjectPtr<UCameraComponent> Camera;

	UPROPERTY(VisibleAnywhere, Category = "Free Fly")
	TObjectPtr<UFloatingPawnMovement> Movement;

	UPROPERTY()
	TObjectPtr<UInputMappingContext> Mapping;

	/** Right, forward and up as one Axis3D value. */
	UPROPERTY()
	TObjectPtr<UInputAction> MoveAction;

	/** The mouse's movement as an Axis2D value. */
	UPROPERTY()
	TObjectPtr<UInputAction> LookAction;

	/** The left mouse button. */
	UPROPERTY()
	TObjectPtr<UInputAction> DragAction;

	/** Either Shift key. */
	UPROPERTY()
	TObjectPtr<UInputAction> FastAction;

	bool bDragging = false;
	bool bFast = false;

	void BuildInput();
	void MapMoveKey(const FKey& Key, EAxis::Type Axis, bool bNegative);
	UEnhancedInputLocalPlayerSubsystem* InputSubsystem(const AController* FromController) const;

	void Move(const FInputActionValue& Value);
	void Look(const FInputActionValue& Value);
	void StartDrag();
	void StopDrag();
	void StartFast();
	void StopFast();
	void ApplySpeed();
};

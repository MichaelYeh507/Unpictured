#include "FreeFlyPawn.h"

#include "Camera/CameraComponent.h"
#include "EnhancedInputComponent.h"
#include "EnhancedInputSubsystems.h"
#include "Engine/LocalPlayer.h"
#include "GameFramework/FloatingPawnMovement.h"
#include "GameFramework/PlayerController.h"
#include "InputAction.h"
#include "InputActionValue.h"
#include "InputMappingContext.h"
#include "InputModifiers.h"
#include "Unpictured.h"

AFreeFlyPawn::AFreeFlyPawn()
{
	PrimaryActorTick.bCanEverTick = false;

	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));

	Camera = CreateDefaultSubobject<UCameraComponent>(TEXT("Camera"));
	Camera->SetupAttachment(RootComponent);
	Camera->bUsePawnControlRotation = true;

	Movement = CreateDefaultSubobject<UFloatingPawnMovement>(TEXT("Movement"));
}

void AFreeFlyPawn::BeginPlay()
{
	Super::BeginPlay();
	ApplySpeed();
}

void AFreeFlyPawn::SetupPlayerInputComponent(UInputComponent* PlayerInputComponent)
{
	Super::SetupPlayerInputComponent(PlayerInputComponent);

	UEnhancedInputComponent* Input = Cast<UEnhancedInputComponent>(PlayerInputComponent);
	if (!Input)
	{
		UE_LOG(LogUnpictured, Error, TEXT("%s needs the Enhanced Input component; check DefaultInput.ini"), *GetName());
		return;
	}

	if (!Mapping)
	{
		BuildInput();
	}

	Input->BindAction(MoveAction, ETriggerEvent::Triggered, this, &AFreeFlyPawn::Move);
	Input->BindAction(LookAction, ETriggerEvent::Triggered, this, &AFreeFlyPawn::Look);
	Input->BindAction(DragAction, ETriggerEvent::Started, this, &AFreeFlyPawn::StartDrag);
	Input->BindAction(DragAction, ETriggerEvent::Completed, this, &AFreeFlyPawn::StopDrag);
	Input->BindAction(FastAction, ETriggerEvent::Started, this, &AFreeFlyPawn::StartFast);
	Input->BindAction(FastAction, ETriggerEvent::Completed, this, &AFreeFlyPawn::StopFast);

	if (UEnhancedInputLocalPlayerSubsystem* Subsystem = InputSubsystem(GetController()))
	{
		Subsystem->AddMappingContext(Mapping, 0);
	}
}

void AFreeFlyPawn::UnPossessed()
{
	// The controller is still set here; the base class clears it.
	if (UEnhancedInputLocalPlayerSubsystem* Subsystem = InputSubsystem(GetController()))
	{
		Subsystem->RemoveMappingContext(Mapping);
	}
	Super::UnPossessed();

	// Key releases can no longer reach the pawn once its input component is gone.
	bDragging = false;
	StopFast();
}

void AFreeFlyPawn::BuildInput()
{
	MoveAction = NewObject<UInputAction>(this, TEXT("Move"));
	MoveAction->ValueType = EInputActionValueType::Axis3D;
	LookAction = NewObject<UInputAction>(this, TEXT("Look"));
	LookAction->ValueType = EInputActionValueType::Axis2D;
	DragAction = NewObject<UInputAction>(this, TEXT("Drag"));
	FastAction = NewObject<UInputAction>(this, TEXT("Fast"));

	Mapping = NewObject<UInputMappingContext>(this, TEXT("FreeFlyMapping"));

	MapMoveKey(EKeys::D, EAxis::X, false);
	MapMoveKey(EKeys::A, EAxis::X, true);
	MapMoveKey(EKeys::W, EAxis::Y, false);
	MapMoveKey(EKeys::S, EAxis::Y, true);
	MapMoveKey(EKeys::E, EAxis::Z, false);
	MapMoveKey(EKeys::Q, EAxis::Z, true);

	Mapping->MapKey(LookAction, EKeys::Mouse2D);
	Mapping->MapKey(DragAction, EKeys::LeftMouseButton);
	Mapping->MapKey(FastAction, EKeys::LeftShift);
	Mapping->MapKey(FastAction, EKeys::RightShift);
}

// A key reads as 1 on X. A swizzle moves that 1 to the Y or Z axis, and a negate flips it.
void AFreeFlyPawn::MapMoveKey(const FKey& Key, EAxis::Type Axis, bool bNegative)
{
	FEnhancedActionKeyMapping& KeyMapping = Mapping->MapKey(MoveAction, Key);
	if (Axis != EAxis::X)
	{
		UInputModifierSwizzleAxis* Swizzle = NewObject<UInputModifierSwizzleAxis>(this);
		Swizzle->Order = (Axis == EAxis::Y) ? EInputAxisSwizzle::YXZ : EInputAxisSwizzle::ZYX;
		KeyMapping.Modifiers.Add(Swizzle);
	}
	if (bNegative)
	{
		KeyMapping.Modifiers.Add(NewObject<UInputModifierNegate>(this));
	}
}

UEnhancedInputLocalPlayerSubsystem* AFreeFlyPawn::InputSubsystem(const AController* FromController) const
{
	const APlayerController* Player = Cast<APlayerController>(FromController);
	return Player ? ULocalPlayer::GetSubsystem<UEnhancedInputLocalPlayerSubsystem>(Player->GetLocalPlayer()) : nullptr;
}

void AFreeFlyPawn::Move(const FInputActionValue& Value)
{
	const FVector Axis = Value.Get<FVector>();
	const FRotator View = GetControlRotation();
	const FRotator Flat(0.0f, View.Yaw, 0.0f);

	// Forward follows the view, pitch included, like the web viewer; sideways stays level.
	AddMovementInput(View.Vector(), Axis.Y);
	AddMovementInput(FRotationMatrix(Flat).GetUnitAxis(EAxis::Y), Axis.X);
	AddMovementInput(FVector::UpVector, Axis.Z);
}

void AFreeFlyPawn::Look(const FInputActionValue& Value)
{
	if (!bDragging)
	{
		return;
	}
	const FVector2D Drag = Value.Get<FVector2D>();
	AddControllerYawInput(Drag.X * LookDegreesPerPixel);
	AddControllerPitchInput(Drag.Y * LookDegreesPerPixel);
}

void AFreeFlyPawn::StartDrag()
{
	bDragging = true;
}

void AFreeFlyPawn::StopDrag()
{
	bDragging = false;
}

void AFreeFlyPawn::StartFast()
{
	bFast = true;
	ApplySpeed();
}

void AFreeFlyPawn::StopFast()
{
	bFast = false;
	ApplySpeed();
}

void AFreeFlyPawn::ApplySpeed()
{
	const float MaxSpeed = Speed * (bFast ? FastMultiplier : 1.0f);
	Movement->MaxSpeed = MaxSpeed;
	// Full speed, or a full stop, in about an eighth of a second.
	Movement->Acceleration = MaxSpeed * 8.0f;
	Movement->Deceleration = MaxSpeed * 8.0f;
}

using UnrealBuildTool;

public class Unpictured : ModuleRules
{
	public Unpictured(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine" });

		// Only the .cpp files use the input modules.
		PrivateDependencyModuleNames.AddRange(new string[] { "InputCore", "EnhancedInput" });
	}
}

"""Makes Content/Maps/Start, the first map: the engine's Basic level (floor, sun, sky,
fog and a player start) plus a few gray blocks to fly around.

Run it from the repo root once the editor target is built. The Python plugin is enabled
for this run only, so the project itself does not carry it:

  "C:\\Program Files\\Epic Games\\UE_5.7\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe" ^
      "%CD%\\unreal\\Unpictured.uproject" -run=pythonscript ^
      -script="%CD%\\unreal\\Tools\\make_start_map.py" ^
      -EnablePlugins=PythonScriptPlugin -nullrhi -unattended -nosplash
"""

import unreal

MAP = "/Game/Maps/Start"
TEMPLATE = "/Engine/Maps/Templates/Template_Default"
CUBE = "/Engine/BasicShapes/Cube"

# Where the player starts, in centimeters: eye height, looking along +X at the blocks.
START = unreal.Vector(-400, 0, 160)

# Blocks: center in centimeters and scale in cube units (a cube is 100 cm). The floor is z = 0.
BLOCKS = [
    (unreal.Vector(600, 0, 100), unreal.Vector(2, 2, 2)),
    (unreal.Vector(100, 700, 150), unreal.Vector(1, 3, 3)),
    (unreal.Vector(-300, -500, 50), unreal.Vector(3, 1, 1)),
    (unreal.Vector(900, 900, 300), unreal.Vector(1, 1, 6)),
]


def main():
    world = unreal.EditorLoadingAndSavingUtils.new_map_from_template(TEMPLATE, False)
    if world is None:
        raise RuntimeError(f"could not open the template level {TEMPLATE}")

    actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    for actor in actors.get_all_level_actors():
        if isinstance(actor, unreal.PlayerStart):
            actor.set_actor_location(START, False, False)
            actor.set_actor_rotation(unreal.Rotator(0, 0, 0), False)

    cube = unreal.load_asset(CUBE)
    for index, (center, scale) in enumerate(BLOCKS):
        block = actors.spawn_actor_from_class(unreal.StaticMeshActor, center)
        block.set_actor_label(f"Block{index + 1}")
        block.static_mesh_component.set_static_mesh(cube)
        block.set_actor_scale3d(scale)

    if not unreal.EditorLoadingAndSavingUtils.save_map(world, MAP):
        raise RuntimeError(f"could not save {MAP}")
    unreal.log(f"saved {MAP} with {len(BLOCKS)} blocks")


main()
